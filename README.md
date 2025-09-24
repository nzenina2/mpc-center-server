# mpc-center-server
learning project
# MPC Center - Asana to Google Calendar Integration

🚀 **Multi-Platform Connection Center** that automatically syncs Asana meeting tasks to Google Calendar.

## Features

- 🔍 Searches Asana for tasks containing "MEETING" (case-insensitive)
- 📅 Creates calendar events from meeting tasks
- ⚡ Automated sync every 4 hours (configurable)
- 📊 Real-time monitoring with logs and statistics
- 🔧 RESTful API for external control
- 🤖 Claude AI integration ready

## Quick Start

### 1. Environment Setup

Copy `.env.example` to `.env` and configure:

```bash
ASANA_TOKEN=your_asana_personal_access_token
ASANA_WORKSPACE_ID=your_workspace_id
GOOGLE_CALENDAR_ID=primary
NODE_ENV=production
```

### 2. Installation

```bash
npm install
npm start
```

### 3. Test the API

```bash
curl http://localhost:3000/health
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/health` | Health check |
| `GET` | `/api/status` | Get current status and stats |
| `GET` | `/api/logs` | Get recent activity logs |
| `POST` | `/api/sync` | Trigger manual sync |
| `POST` | `/api/start` | Start automation |
| `POST` | `/api/stop` | Stop automation |
| `POST` | `/api/config` | Update configuration |
| `DELETE` | `/api/logs` | Clear logs |

## Configuration

### Required Environment Variables

- `ASANA_TOKEN`: Your Asana Personal Access Token
- `ASANA_WORKSPACE_ID`: Your Asana Workspace ID

### Optional Environment Variables

- `GOOGLE_CALENDAR_ID`: Target calendar (default: "primary")
- `DEFAULT_SEARCH_KEYWORD`: Search term for tasks (default: "MEETING")
- `DEFAULT_INTERVAL_HOURS`: Sync frequency (default: 4)
- `PORT`: Server port (default: 3000)

## Getting API Credentials

### Asana Setup

1. Go to [Asana Developer Console](https://app.asana.com/0/my-apps)
2. Click "Create new token"
3. Copy your Personal Access Token
4. Find your Workspace ID in Asana URL or API

### Google Calendar Setup

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Enable Google Calendar API
3. Create OAuth2 credentials
4. Get client ID, secret, and refresh token

## Deployment

### Railway (Recommended)

1. Connect your GitHub repository to [Railway](https://railway.app)
2. Set environment variables in Railway dashboard
3. Deploy automatically

### Other Platforms

- **Render**: Connect GitHub repo, set environment variables
- **Heroku**: Use `git push heroku main` after setup
- **Docker**: Use the included Dockerfile

## Usage with Claude AI

Once deployed, add as a custom connector in Claude:

1. Go to Claude Settings → Connectors
2. Add custom connector with your deployed URL
3. Use natural language to control: "Start MPC automation", "Check sync status"

## Example Usage

```javascript
// Start automation
POST /api/start

// Check status
GET /api/status
// Response: { "isRunning": true, "stats": {...}, "config": {...} }

// Manual sync
POST /api/sync
// Response: { "success": true, "tasksFound": 3, "eventsCreated": 2 }
```

## Monitoring

The server provides detailed logging for all operations:

- 🚀 Sync process start/completion
- 🔍 Asana task search results
- 📅 Calendar event creation
- ❌ Error handling and debugging
- ⚡ Automation status changes

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## License

MIT License - see LICENSE file for details

## Support

For issues and questions:

1. Check the logs: `GET /api/logs`
2. Verify configuration: `GET /api/status`
3. Test connection: `GET /health`
4. Create an issue on GitHub

## Changelog

### v1.0.0
- Initial release
- Asana task search integration
- Google Calendar sync (mock implementation)
- RESTful API
- Automated scheduling
- Claude AI connector support
