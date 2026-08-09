import React from 'react'
import ReactDOM from 'react-dom/client'
import axios from 'axios'
import App from './App.jsx'
import { getInitialTheme, applyTheme } from './theme.js'
import { getInitialPalette, applyPalette } from './palette.js'
import './index.css'

// Set before first render so there's no flash of the wrong theme/palette.
applyTheme(getInitialTheme())
applyPalette(getInitialPalette())

// The tab title is set by GuildProvider once the active guild is known — it
// can't be decided here any more, because which guild this browser is looking
// at isn't known until the session has been read.

// Send the session cookie with every API call (matters if the API is ever
// served from a different origin than the frontend).
axios.defaults.withCredentials = true

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
