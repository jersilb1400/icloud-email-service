/**
 * iCloud Email Service - IMAP/SMTP Bridge for MCP
 * Runs on Render.com to provide HTTP API for email operations
 */

import express from 'express';
import Imap from 'imap';
import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';
import cors from 'cors';

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// iCloud IMAP/SMTP settings
const ICLOUD_IMAP = {
  host: 'imap.mail.me.com',
  port: 993,
  tls: true,
  tlsOptions: { rejectUnauthorized: false }
};

const ICLOUD_SMTP = {
  host: 'smtp.mail.me.com',
  port: 465,
  secure: true,
  connectionTimeout: 30000,
  greetingTimeout: 30000,
  socketTimeout: 60000
};

// Mailgun configuration for sending emails (set via Render environment variables)
const MAILGUN_API_KEY = process.env.MAILGUN_API_KEY;
const MAILGUN_DOMAIN = process.env.MAILGUN_DOMAIN;

// Health check
app.get('/', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'iCloud Email Bridge',
    version: '1.0.0',
    endpoints: ['/health', '/mailboxes', '/emails', '/search', '/send']
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Helper: Create IMAP connection
function createImapConnection(username, password) {
  return new Imap({
    user: username,
    password: password,
    ...ICLOUD_IMAP
  });
}

// Helper: Promisify IMAP operations
function imapConnect(imap) {
  return new Promise((resolve, reject) => {
    imap.once('ready', () => resolve());
    imap.once('error', (err) => reject(err));
    imap.connect();
  });
}

function imapGetBoxes(imap) {
  return new Promise((resolve, reject) => {
    imap.getBoxes((err, boxes) => {
      if (err) reject(err);
      else resolve(boxes);
    });
  });
}

function imapOpenBox(imap, mailbox, readOnly = true) {
  return new Promise((resolve, reject) => {
    imap.openBox(mailbox, readOnly, (err, box) => {
      if (err) reject(err);
      else resolve(box);
    });
  });
}

function imapSearch(imap, criteria) {
  return new Promise((resolve, reject) => {
    imap.search(criteria, (err, results) => {
      if (err) reject(err);
      else resolve(results);
    });
  });
}

function imapFetch(imap, uids, options) {
  return new Promise((resolve, reject) => {
    const messages = [];
    const fetch = imap.fetch(uids, options);
    
    fetch.on('message', (msg, seqno) => {
      let buffer = '';
      let attributes = {};
      
      msg.on('body', (stream) => {
        stream.on('data', (chunk) => {
          buffer += chunk.toString('utf8');
        });
      });
      
      msg.once('attributes', (attrs) => {
        attributes = attrs;
      });
      
      msg.once('end', () => {
        messages.push({ buffer, attributes, seqno });
      });
    });
    
    fetch.once('error', (err) => reject(err));
    fetch.once('end', () => resolve(messages));
  });
}

// Flatten mailbox tree for display
function flattenMailboxes(boxes, prefix = '') {
  const result = [];
  for (const [name, box] of Object.entries(boxes)) {
    const fullPath = prefix ? `${prefix}${box.delimiter}${name}` : name;
    result.push({
      name: name,
      path: fullPath,
      delimiter: box.delimiter,
      flags: box.attribs || [],
      hasChildren: box.children && Object.keys(box.children).length > 0
    });
    if (box.children) {
      result.push(...flattenMailboxes(box.children, fullPath));
    }
  }
  return result;
}

/**
 * GET /mailboxes - List all mailboxes/folders
 * Query params: username, password
 */
app.get('/mailboxes', async (req, res) => {
  const { username, password } = req.query;
  
  if (!username || !password) {
    return res.status(400).json({ error: 'Missing username or password' });
  }
  
  const imap = createImapConnection(username, password);
  
  try {
    await imapConnect(imap);
    const boxes = await imapGetBoxes(imap);
    const mailboxes = flattenMailboxes(boxes);
    imap.end();
    
    res.json({ 
      success: true, 
      mailboxes,
      count: mailboxes.length
    });
  } catch (err) {
    imap.end();
    console.error('Mailbox error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /emails - Get emails from a mailbox
 * Query params: username, password, mailbox (default: INBOX), limit (default: 20)
 */
app.get('/emails', async (req, res) => {
  const { username, password, mailbox = 'INBOX', limit = 20 } = req.query;
  
  if (!username || !password) {
    return res.status(400).json({ error: 'Missing username or password' });
  }
  
  const imap = createImapConnection(username, password);
  
  try {
    await imapConnect(imap);
    const box = await imapOpenBox(imap, mailbox);
    
    if (box.messages.total === 0) {
      imap.end();
      return res.json({ success: true, emails: [], total: 0 });
    }
    
    // Search for recent emails (last 30 days) instead of using sequence numbers
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    
    const uids = await imapSearch(imap, [['SINCE', thirtyDaysAgo]]);
    
    // Get the most recent ones (by UID, which correlates with arrival time)
    const recentUids = uids.slice(-parseInt(limit));
    
    if (recentUids.length === 0) {
      // Fallback: if no emails in last 30 days, get the last N by sequence
      const totalMessages = box.messages.total;
      const startSeq = Math.max(1, totalMessages - parseInt(limit) + 1);
      recentUids.push(...Array.from({length: Math.min(parseInt(limit), totalMessages)}, (_, i) => startSeq + i));
    }
    
    const rawMessages = await imapFetch(imap, recentUids, {
      bodies: '',
      struct: true
    });
    
    // Parse messages
    const emails = [];
    for (const raw of rawMessages) {
      try {
        const parsed = await simpleParser(raw.buffer);
        emails.push({
          uid: raw.attributes.uid,
          date: parsed.date?.toISOString(),
          from: parsed.from?.text || 'Unknown',
          to: parsed.to?.text || '',
          subject: parsed.subject || '(No Subject)',
          preview: parsed.text?.substring(0, 200) || parsed.html?.substring(0, 200) || '',
          hasAttachments: parsed.attachments?.length > 0,
          flags: raw.attributes.flags || []
        });
      } catch (parseErr) {
        console.error('Parse error:', parseErr.message);
      }
    }
    
    // Sort by date descending
    emails.sort((a, b) => new Date(b.date) - new Date(a.date));
    
    imap.end();
    res.json({ 
      success: true, 
      emails,
      total: totalMessages,
      mailbox,
      returned: emails.length
    });
  } catch (err) {
    imap.end();
    console.error('Email fetch error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /email/:uid - Get a single email by UID
 * Query params: username, password, mailbox (default: INBOX)
 */
app.get('/email/:uid', async (req, res) => {
  const { uid } = req.params;
  const { username, password, mailbox = 'INBOX' } = req.query;
  
  if (!username || !password) {
    return res.status(400).json({ error: 'Missing username or password' });
  }
  
  const imap = createImapConnection(username, password);
  
  try {
    await imapConnect(imap);
    await imapOpenBox(imap, mailbox);
    
    const rawMessages = await imapFetch(imap, uid, {
      bodies: '',
      struct: true
    });
    
    if (rawMessages.length === 0) {
      imap.end();
      return res.status(404).json({ error: 'Email not found' });
    }
    
    const parsed = await simpleParser(rawMessages[0].buffer);
    
    const email = {
      uid: parseInt(uid),
      date: parsed.date?.toISOString(),
      from: parsed.from?.text || 'Unknown',
      to: parsed.to?.text || '',
      cc: parsed.cc?.text || '',
      subject: parsed.subject || '(No Subject)',
      text: parsed.text || '',
      html: parsed.html || '',
      attachments: parsed.attachments?.map(att => ({
        filename: att.filename,
        contentType: att.contentType,
        size: att.size
      })) || [],
      flags: rawMessages[0].attributes.flags || []
    };
    
    imap.end();
    res.json({ success: true, email });
  } catch (err) {
    imap.end();
    console.error('Email fetch error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /search - Search emails
 * Query params: username, password, mailbox, query, from, to, subject, since, before
 */
app.get('/search', async (req, res) => {
  const { 
    username, password, 
    mailbox = 'INBOX',
    query,      // General text search
    from,       // From address
    to,         // To address
    subject,    // Subject contains
    since,      // Date (YYYY-MM-DD)
    before,     // Date (YYYY-MM-DD)
    limit = 50
  } = req.query;
  
  if (!username || !password) {
    return res.status(400).json({ error: 'Missing username or password' });
  }
  
  const imap = createImapConnection(username, password);
  
  try {
    await imapConnect(imap);
    await imapOpenBox(imap, mailbox);
    
    // Build search criteria
    const criteria = [];
    if (query) criteria.push(['TEXT', query]);
    if (from) criteria.push(['FROM', from]);
    if (to) criteria.push(['TO', to]);
    if (subject) criteria.push(['SUBJECT', subject]);
    if (since) criteria.push(['SINCE', new Date(since)]);
    if (before) criteria.push(['BEFORE', new Date(before)]);
    
    if (criteria.length === 0) {
      criteria.push('ALL');
    }
    
    const uids = await imapSearch(imap, criteria);
    
    // Limit results
    const limitedUids = uids.slice(-parseInt(limit));
    
    if (limitedUids.length === 0) {
      imap.end();
      return res.json({ success: true, emails: [], total: 0 });
    }
    
    const rawMessages = await imapFetch(imap, limitedUids, {
      bodies: '',
      struct: true
    });
    
    const emails = [];
    for (const raw of rawMessages) {
      try {
        const parsed = await simpleParser(raw.buffer);
        emails.push({
          uid: raw.attributes.uid,
          date: parsed.date?.toISOString(),
          from: parsed.from?.text || 'Unknown',
          to: parsed.to?.text || '',
          subject: parsed.subject || '(No Subject)',
          preview: parsed.text?.substring(0, 200) || '',
          flags: raw.attributes.flags || []
        });
      } catch (parseErr) {
        console.error('Parse error:', parseErr.message);
      }
    }
    
    emails.sort((a, b) => new Date(b.date) - new Date(a.date));
    
    imap.end();
    res.json({ 
      success: true, 
      emails,
      total: uids.length,
      returned: emails.length
    });
  } catch (err) {
    imap.end();
    console.error('Search error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Send email via Mailgun HTTP API
 */
async function sendViaMailgun(from, to, subject, text, html, cc, bcc) {
  const formData = new URLSearchParams();
  formData.append('from', from);
  formData.append('to', to);
  formData.append('subject', subject);
  if (text) formData.append('text', text);
  if (html) formData.append('html', html);
  if (cc) formData.append('cc', cc);
  if (bcc) formData.append('bcc', bcc);
  
  const auth = Buffer.from(`api:${MAILGUN_API_KEY}`).toString('base64');
  
  const response = await fetch(`https://api.mailgun.net/v3/${MAILGUN_DOMAIN}/messages`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: formData.toString()
  });
  
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Mailgun error: ${response.status} - ${errorText}`);
  }
  
  return await response.json();
}

/**
 * POST /send - Send an email via Mailgun
 * Body: { username, password, to, subject, text, html, cc, bcc }
 */
app.post('/send', async (req, res) => {
  const { username, to, subject, text, html, cc, bcc } = req.body;
  
  if (!to || !subject) {
    return res.status(400).json({ error: 'Missing required fields: to, subject' });
  }
  
  try {
    // Use the user's iCloud email as the "from" address (via Mailgun)
    const fromAddress = username || `noreply@${MAILGUN_DOMAIN}`;
    const result = await sendViaMailgun(fromAddress, to, subject, text, html, cc, bcc);
    
    res.json({ 
      success: true, 
      messageId: result.id,
      message: 'Email sent successfully via Mailgun'
    });
  } catch (err) {
    console.error('Send error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// MCP-compatible endpoint for the Cloudflare Worker to call
app.post('/mcp', async (req, res) => {
  const { method, params } = req.body;
  const { username, password } = params || {};
  
  try {
    switch (method) {
      case 'list_mailboxes': {
        const imap = createImapConnection(username, password);
        await imapConnect(imap);
        const boxes = await imapGetBoxes(imap);
        const mailboxes = flattenMailboxes(boxes);
        imap.end();
        return res.json({ result: { mailboxes } });
      }
      
      case 'get_emails': {
        const { mailbox = 'INBOX', limit = 20 } = params;
        const imap = createImapConnection(username, password);
        await imapConnect(imap);
        const box = await imapOpenBox(imap, mailbox);
        
        if (box.messages.total === 0) {
          imap.end();
          return res.json({ result: { emails: [], total: 0 } });
        }
        
        // Search for recent emails (last 30 days) to get truly recent messages
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
        
        let uids = await imapSearch(imap, [['SINCE', thirtyDaysAgo]]);
        
        // Get the most recent ones
        let recentUids = uids.slice(-parseInt(limit));
        
        // Fallback if no recent emails
        if (recentUids.length === 0) {
          const totalMessages = box.messages.total;
          const startSeq = Math.max(1, totalMessages - parseInt(limit) + 1);
          recentUids = Array.from({length: Math.min(parseInt(limit), totalMessages)}, (_, i) => startSeq + i);
        }
        
        const rawMessages = await imapFetch(imap, recentUids, { bodies: '', struct: true });
        
        const emails = [];
        for (const raw of rawMessages) {
          const parsed = await simpleParser(raw.buffer);
          emails.push({
            uid: raw.attributes.uid,
            date: parsed.date?.toISOString(),
            from: parsed.from?.text || 'Unknown',
            to: parsed.to?.text || '',
            subject: parsed.subject || '(No Subject)',
            preview: parsed.text?.substring(0, 200) || '',
            flags: raw.attributes.flags || []
          });
        }
        
        emails.sort((a, b) => new Date(b.date) - new Date(a.date));
        imap.end();
        return res.json({ result: { emails, total: uids.length } });
      }
      
      case 'search_emails': {
        const { mailbox = 'INBOX', query, from, subject, limit = 50 } = params;
        const imap = createImapConnection(username, password);
        await imapConnect(imap);
        await imapOpenBox(imap, mailbox);
        
        const criteria = [];
        if (query) criteria.push(['TEXT', query]);
        if (from) criteria.push(['FROM', from]);
        if (subject) criteria.push(['SUBJECT', subject]);
        if (criteria.length === 0) criteria.push('ALL');
        
        const uids = await imapSearch(imap, criteria);
        const limitedUids = uids.slice(-parseInt(limit));
        
        if (limitedUids.length === 0) {
          imap.end();
          return res.json({ result: { emails: [], total: 0 } });
        }
        
        const rawMessages = await imapFetch(imap, limitedUids, { bodies: '', struct: true });
        
        const emails = [];
        for (const raw of rawMessages) {
          const parsed = await simpleParser(raw.buffer);
          emails.push({
            uid: raw.attributes.uid,
            date: parsed.date?.toISOString(),
            from: parsed.from?.text || 'Unknown',
            subject: parsed.subject || '(No Subject)',
            preview: parsed.text?.substring(0, 200) || ''
          });
        }
        
        emails.sort((a, b) => new Date(b.date) - new Date(a.date));
        imap.end();
        return res.json({ result: { emails, total: uids.length } });
      }
      
      case 'send_email': {
        const { to, subject, text, html, cc, bcc } = params;
        // Use Mailgun to send emails (more reliable than SMTP on cloud platforms)
        const fromAddress = username || `noreply@${MAILGUN_DOMAIN}`;
        const result = await sendViaMailgun(fromAddress, to, subject, text, html, cc, bcc);
        return res.json({ result: { success: true, messageId: result.id } });
      }
      
      default:
        return res.status(400).json({ error: `Unknown method: ${method}` });
    }
  } catch (err) {
    console.error('MCP error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 iCloud Email Service running on port ${PORT}`);
  console.log(`📧 IMAP: ${ICLOUD_IMAP.host}:${ICLOUD_IMAP.port}`);
  console.log(`📤 SMTP: ${ICLOUD_SMTP.host}:${ICLOUD_SMTP.port}`);
});
