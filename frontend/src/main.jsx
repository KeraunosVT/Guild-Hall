import React from 'react'
import ReactDOM from 'react-dom/client'
import axios from 'axios'
import App from './App.jsx'
import { getInitialTheme, applyTheme } from './theme.js'
import { getInitialPalette, applyPalette } from './palette.js'
import { GUILD } from './guild.js'
import './index.css'

// Set before first render so there's no flash of the wrong theme/palette.
applyTheme(getInitialTheme())
applyPalette(getInitialPalette())

// index.html can't import guild.js, so its <title> is a hand-kept literal —
// which is exactly how the browser tab kept saying the old guild name after a
// rename. Setting it here means shared/guild.json stays the only place to edit.
document.title = `${GUILD.house} — Guild Hall`

// Send the session cookie with every API call (matters if the API is ever
// served from a different origin than the frontend).
axios.defaults.withCredentials = true

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
