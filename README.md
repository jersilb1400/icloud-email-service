# iCloud Email Service

A Node.js IMAP/SMTP bridge for iCloud Mail, designed to work with Claude AI via MCP.

## Features

- 📥 **Read Emails** - List emails from any mailbox/folder
- 📤 **Send Emails** - Compose and send via iCloud SMTP
- 🔍 **Search** - Search by text, sender, subject, date
- 📁 **Mailboxes** - List all folders (Inbox, Sent, Drafts, etc.)

## Deployment to Render

### Option 1: Deploy via Render Dashboard

1. Go to [render.com](https://render.com) and sign in
2. Click **New** → **Web Service**
3. Select **Build and deploy from a Git repository** or use **Deploy from URL**
4. For Git: Connect your GitHub and push this folder to a repo
5. Configure:
   - **Name**: `icloud-email-service`
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Plan**: Free
6. Click **Create Web Service**

### Option 2: Deploy via Render MCP (if available)

```
Create web service:
- name: icloud-email-service
- runtime: node
- buildCommand: npm install
- startCommand: npm start
```

## API Endpoints

### Health Check
```
GET /health
```

### List Mailboxes
```
GET /mailboxes?username=EMAIL&password=APP_PASSWORD
```

### Get Emails
```
GET /emails?username=EMAIL&password=APP_PASSWORD&mailbox=INBOX&limit=20
```

### Get Single Email
```
GET /email/:uid?username=EMAIL&password=APP_PASSWORD&mailbox=INBOX
```

### Search Emails
```
GET /search?username=EMAIL&password=APP_PASSWORD&query=TEXT&from=SENDER&subject=SUBJECT
```

### Send Email
```
POST /send
Body: {
  "username": "EMAIL",
  "password": "APP_PASSWORD",
  "to": "recipient@example.com",
  "subject": "Hello",
  "text": "Message body"
}
```

### MCP Endpoint (for Cloudflare Worker)
```
POST /mcp
Body: {
  "method": "list_mailboxes|get_emails|search_emails|send_email",
  "params": { "username": "...", "password": "...", ...other params }
}
```

## iCloud Credentials

You need an **App-Specific Password** for iCloud Mail:

1. Go to [appleid.apple.com](https://appleid.apple.com)
2. Sign in with your Apple ID
3. Go to **Sign-In and Security** → **App-Specific Passwords**
4. Generate a new password for "Email Service"
5. Use your Apple ID email and this app-specific password

## Environment Variables

No required environment variables. The service uses iCloud's standard servers:
- IMAP: `imap.mail.me.com:993` (SSL)
- SMTP: `smtp.mail.me.com:587` (TLS)

## Testing Locally

```bash
cd email-service
npm install
npm start
# Server runs on http://localhost:3000

# Test health
curl http://localhost:3000/health

# Test mailboxes (replace with your credentials)
curl "http://localhost:3000/mailboxes?username=YOUR_EMAIL&password=YOUR_APP_PASSWORD"
```
