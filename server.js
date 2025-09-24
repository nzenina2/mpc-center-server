// Add these imports at the top of your server.js file
const { google } = require('googleapis');
const { OAuth2Client } = require('google-auth-library');

// Add these to your config object
let config = {
  asanaToken: process.env.ASANA_TOKEN || '',
  asanaWorkspaceId: process.env.ASANA_WORKSPACE_ID || '',
  googleCalendarId: process.env.GOOGLE_CALENDAR_ID || 'primary',
  intervalHours: parseInt(process.env.DEFAULT_INTERVAL_HOURS) || 4,
  searchKeyword: process.env.DEFAULT_SEARCH_KEYWORD || 'MEETING',
  googleClientId: process.env.GOOGLE_CLIENT_ID || '',
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
  googleRedirectUri: process.env.GOOGLE_REDIRECT_URI || 'https://mpc-center-server-production.up.railway.app/auth/google/callback',
  googleRefreshToken: process.env.GOOGLE_REFRESH_TOKEN || ''
};

// Google OAuth2 client setup
const oauth2Client = new OAuth2Client(
  config.googleClientId,
  config.googleClientSecret,
  config.googleRedirectUri
);

// Set refresh token if available
if (config.googleRefreshToken) {
  oauth2Client.setCredentials({
    refresh_token: config.googleRefreshToken
  });
}

// Google Calendar API setup
const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

// Replace your existing addToGoogleCalendar function with this:
const addToGoogleCalendar = async (task) => {
  try {
    // Check if we have Google credentials
    if (!config.googleClientId || !config.googleClientSecret) {
      throw new Error('Google Calendar credentials not configured');
    }

    if (!config.googleRefreshToken) {
      throw new Error('Google Calendar not authenticated. Please visit /auth/google to authenticate.');
    }

    // Ensure we have valid access token
    try {
      await oauth2Client.getAccessToken();
    } catch (error) {
      throw new Error('Failed to get Google access token. Please re-authenticate.');
    }

    const startDate = task.due_on ? new Date(task.due_on + 'T09:00:00Z') : new Date();
    const endDate = new Date(startDate.getTime() + 60 * 60 * 1000); // 1 hour duration

    const event = {
      summary: task.name,
      description: `${task.notes || 'No description available'}\n\nFrom Asana Task: https://app.asana.com/0/0/${task.gid}`,
      start: {
        dateTime: startDate.toISOString(),
        timeZone: 'UTC'
      },
      end: {
        dateTime: endDate.toISOString(),
        timeZone: 'UTC'
      },
      source: {
        title: 'MPC Center',
        url: `https://app.asana.com/0/0/${task.gid}`
      }
    };

    addLog(`Creating Google Calendar event: ${task.name}`, 'info');

    const response = await calendar.events.insert({
      calendarId: config.googleCalendarId,
      resource: event,
    });

    addLog(`✅ Created Google Calendar event: ${task.name}`, 'success');

    return {
      success: true,
      eventId: response.data.id,
      eventUrl: response.data.htmlLink,
      startTime: startDate.toISOString(),
      endTime: endDate.toISOString()
    };

  } catch (error) {
    addLog(`❌ Google Calendar error: ${error.message}`, 'error');
    throw new Error(`Google Calendar API error: ${error.message}`);
  }
};

// Add Google OAuth authentication routes

// Route to start Google authentication
app.get('/auth/google', (req, res) => {
  const scopes = ['https://www.googleapis.com/auth/calendar'];
  
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: scopes,
    prompt: 'consent'
  });

  res.redirect(authUrl);
});

// OAuth callback route
app.get('/auth/google/callback', async (req, res) => {
  const { code } = req.query;

  try {
    const { tokens } = await oauth2Client.getToken(code);
    
    // Store the refresh token (in production, store this securely in database)
    if (tokens.refresh_token) {
      config.googleRefreshToken = tokens.refresh_token;
      addLog('✅ Google Calendar authenticated successfully', 'success');
      
      res.send(`
        <html>
          <head><title>Google Calendar Connected</title></head>
          <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px;">
            <h1>✅ Google Calendar Connected Successfully!</h1>
            <p>Your MPC Center can now create calendar events.</p>
            <p><strong>Important:</strong> Add this to your Railway environment variables:</p>
            <code style="background: #f5f5f5; padding: 10px; display: block; margin: 20px;">
              GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}
            </code>
            <p>Then restart your server for the change to take effect.</p>
            <a href="/" style="color: #007bff; text-decoration: none;">← Back to MPC Center</a>
          </body>
        </html>
      `);
    } else {
      res.status(400).send('No refresh token received. Please try again.');
    }

  } catch (error) {
    addLog(`❌ Google authentication failed: ${error.message}`, 'error');
    res.status(500).send(`Authentication failed: ${error.message}`);
  }
});

// Add route to check Google Calendar connection status
app.get('/api/google-status', async (req, res) => {
  try {
    const isConfigured = !!(config.googleClientId && config.googleClientSecret);
    const isAuthenticated = !!config.googleRefreshToken;
    
    let canCreateEvents = false;
    if (isAuthenticated) {
      try {
        await oauth2Client.getAccessToken();
        canCreateEvents = true;
      } catch (error) {
        // Token might be expired or invalid
      }
    }

    res.json({
      configured: isConfigured,
      authenticated: isAuthenticated,
      canCreateEvents,
      authUrl: isConfigured ? '/auth/google' : null,
      calendarId: config.googleCalendarId
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
