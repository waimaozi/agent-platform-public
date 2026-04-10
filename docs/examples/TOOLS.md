# Tools & Services

List what your agent can access — but NOT the secrets themselves.
Secrets belong in .env ONLY, never in this file.

This file gets loaded into the AI's system prompt on every call.
If you put passwords here, they will be visible in prompt logs.

## Example entries (safe):

## Email
- Can send email via SMTP (configured in .env)
- From address: configured in SMTP_USER

## CRM
- Baserow at http://YOUR_IP:8280
- Has tables: contacts, projects, communications

## N8N
- Workflow automation at https://your-n8n.com
- API access configured in .env
