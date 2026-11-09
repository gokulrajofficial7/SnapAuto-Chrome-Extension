# SnapAuto – Snapchat Web Chrome Extension

[![Manifest V3](https://img.shields.io/badge/Chrome%20Extension-Manifest%20V3-blue.svg)](https://developer.chrome.com/docs/extensions/mv3/intro/)
[![JavaScript](https://img.shields.io/badge/Language-JavaScript%20ES6+-yellow.svg)](https://developer.mozilla.org/en-US/docs/Web/JavaScript)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-Snapchat%20Web-brightgreen.svg)](https://web.snapchat.com)

A modern, lightweight Google Chrome extension built with **Manifest V3** featuring a compact floating dashboard, live conversation activity monitoring, real-time session statistics, and browser-based controls designed specifically for **[Snapchat Web](https://web.snapchat.com)**.

---

## 📌 Project Overview

**SnapAuto** is an open-source browser extension developed to enhance productivity and conversation awareness on Snapchat Web. Navigating modern web-based social messaging applications with extensive contact lists can be overwhelming. SnapAuto injects a non-intrusive, dark-themed floating heads-up display (HUD) directly into the Snapchat Web interface alongside a dedicated browser toolbar popup. It enables users to monitor incoming conversation activity, track unread indicators across their friend feed, observe real-time session statistics, and configure execution pacing to maintain a smooth browser experience.

Developed as an independent Computer Science Engineering portfolio project, SnapAuto showcases modern Chrome Extension development practices, asynchronous JavaScript state management, and respectful interaction with virtualized web applications.

---

## ❗ Problem Statement

Active social messaging accounts frequently accumulate high volumes of incoming messages, friend interactions, and conversation updates. When interacting with Snapchat through a desktop browser:

1. **Information Overload:** Managing dozens or hundreds of active conversations in a single scrollable feed makes it easy to lose track of unopened conversations or newly arrived messages.
2. **Lack of Session Transparency:** The standard web interface does not provide session-level activity telemetry (e.g., how many conversations have been reviewed during an active study or work session).
3. **Desktop vs. Mobile Discrepancies:** Many interactions on Snapchat are mobile-restricted (e.g., snaps that require native camera hardware). Users often click notifications only to be blocked by unsupported web dialogs.
4. **Virtual DOM Hydration Lag:** Dynamic, virtualized lists in Single Page Applications (SPAs) discard off-screen elements, complicating systematic conversation tracking without polite, step-by-step scrolling.

---

## 🎯 Project Objectives

- **Develop a Compliant Manifest V3 Extension:** Utilize Chrome's latest extension standard with service-worker-ready modular scripts and least-privilege host permissions.
- **Deliver an Ergonomic Dashboard:** Provide an in-page, draggable, dark-themed HUD with minimal screen footprint and a minimize-to-pill mode.
- **Implement Real-Time Activity Monitoring:** Detect conversation updates, track unread indicators across the sidebar feed, and log actions transparently.
- **Provide Session Telemetry:** Maintain session-level and persistent analytics using the `chrome.storage.local` API.
- **Respect Platform Constraints:** Gracefully detect and report mobile-only media notices without causing UI stalls or bypassing platform rules.

---

## 🌟 Key Features

| Feature | Description |
| :--- | :--- |
| **Manifest V3 Architecture** | Modern extension architecture adhering to Google Chrome's latest standards. |
| **Compact Floating Dashboard** | Draggable, glassmorphic dark HUD overlay injected directly on `web.snapchat.com`. |
| **Minimize to Pill Mode** | Collapse the dashboard into a compact, unobtrusive status pill showing live event counters. |
| **Live Activity Monitoring** | Real-time tracking of conversation states, unread badges, and feed interactions. |
| **Console Activity Log** | Embedded live log displaying timestamped status updates directly in the HUD. |
| **Session Statistics** | Real-time tracking of session events, total conversations monitored, and one-click stats reset. |
| **Manual Pacing Controls** | Interactive Start, Pause, Resume, and Stop controls available both in-page and via toolbar popup. |
| **Configurable Presets** | Instant speed presets (`⚡ Fast 1.2s`, `⚖ Balanced 2.0s`, `🛡 Relaxed 3.5s`) for check intervals. |
| **Two-Tier Verification** | Confirms conversation state consistency between the active chat pane and sidebar indicators. |
| **Mobile-Only Detection** | Instantly identifies snaps restricted to the mobile app and alerts the user rather than getting stuck. |
| **Safe Guard Rails** | Built-in safety filters prevent accidental interaction with call, delete, report, or story buttons. |
| **Synchronized Popup UI** | Action popup synchronizes seamlessly with the content script via `chrome.storage.onChanged`. |

---

## 💻 Technologies Used

- **HTML5:** Semantic markup for extension popup controls and floating dashboard structure.
- **CSS3:** Custom responsive styling featuring CSS custom properties, backdrop blur filters, and transitions.
- **JavaScript (ES6+):** Pure vanilla JavaScript utilizing modern async/await, TreeWalker API, and EventTarget dispatching.
- **Chrome Extension Manifest V3:** Utilizing declarative permissions, content scripts, and action popups.
- **Chrome Storage API (`chrome.storage.local`):** Persistent settings, activity counters, and cross-context synchronization.
- **DOM & TreeWalker APIs:** High-performance, memory-efficient DOM traversal to detect conversation status nodes without heavy dependencies.

---

## 🏗 How It Works

SnapAuto operates through a clean, decoupled architecture:

```
+-----------------------------------------------------------+
|                   Google Chrome Browser                   |
+-----------------------------------------------------------+
       |                                            |
       v                                            v
+-----------------------+              +-------------------------+
|     Action Popup      |              |   Snapchat Web Page     |
| (popup.html / .js)    |              | (web.snapchat.com)      |
+-----------------------+              +-------------------------+
       |                                            |
       |  chrome.storage.local / onChanged          |
       +--------------------+-----------------------+
                            |
                            v
               +--------------------------+
               |  Content Script Engine   |
               |  (content.js / .css)     |
               +--------------------------+
                            |
           +----------------+----------------+
           |                                 |
           v                                 v
+----------------------+         +-----------------------+
| 15-State Machine     |         | Floating HUD UI       |
| - IDLE               |         | - Draggable Panel     |
| - SCANNING_CHAT      | <-----> | - Status Indicator    |
| - VERIFYING_STATUS   |         | - Live Console Log    |
| - PAUSED / COMPLETED |         | - Speed Presets       |
+----------------------+         +-----------------------+
```

1. **Injection:** When the user navigates to `https://web.snapchat.com`, the content script initializes, verifies host domain isolation, and injects the floating HUD and CSS variables.
2. **State Machine Management:** A 15-state finite state machine manages transitions between standing by (`IDLE`), scanning conversations (`SCANNING_CHAT`), progressive upward scrolling for older messages (`SCROLLING_UP`), verifying completion (`VERIFYING_SIDEBAR_STATUS`), and pausing for user input (`PAUSED`).
3. **Safety Watchdog:** Traversal filters evaluate bounding rectangles and element roles to ensure navigation only targets conversation threads, rigorously ignoring top navigation bars, call triggers, story circles, and search bars.
4. **Bidirectional Storage Synchronization:** Modifications made in the toolbar popup are persisted to `chrome.storage.local` and broadcasted via `chrome.storage.onChanged` to immediately update in-page HUD behavior.

---

## 📥 Installation Guide

Follow these simple steps to load SnapAuto into Google Chrome:

### Step 1: Clone or Download the Repository
Clone the repository using Git:
```bash
git clone https://github.com/gokulrajofficial7/SnapAuto-Chrome-Extension.git
```
*(Alternatively, click **Code > Download ZIP** on GitHub and extract the archive on your computer).*

### Step 2: Open Chrome Extensions
1. Launch **Google Chrome**.
2. In the address bar, navigate to:
   ```
   chrome://extensions
   ```

### Step 3: Enable Developer Mode
Locate the **Developer mode** toggle in the top-right corner of the Extensions page and turn it **ON**.

### Step 4: Load the Unpacked Extension
1. Click the **Load unpacked** button in the top-left corner.
2. In the file picker dialog, navigate to and select the `SnapAuto-Chrome-Extension` folder (the folder containing `manifest.json`).
3. Click **Select Folder**.

### Step 5: Pin and Access the Extension
1. Click the puzzle icon (Extensions menu) in Chrome's top toolbar.
2. Click the pin icon next to **SnapAuto** to keep it readily accessible.
3. Open **[https://web.snapchat.com](https://web.snapchat.com)**, log in, and the SnapAuto HUD will appear in the bottom-right corner.

---

## 🎯 Advantages

- **Clean & Intuitive Interface:** Glassmorphic dark styling seamlessly blends with Snapchat Web's native dark mode.
- **Enhanced Activity Visibility:** Real-time counters and status logs give users instant awareness of their session interactions.
- **Organized Pacing:** Built-in delays and safe rate-limiting prevent browser tab freezing during extended sessions.
- **Zero External Dependencies:** Built with 100% native Web APIs without heavy external libraries or bundle bloat.
- **Modular Codebase:** Clean separation of concerns across manifest, popup controllers, content scripts, and styles.
- **Beginner-Friendly Setup:** Installs in seconds via standard Chrome Developer Mode without requiring complex build steps or node packages.

---

## 💡 Project Use Cases

- **Desktop Conversation Organization:** Ideal for users managing high-volume incoming conversations who need visual indicators of pending messages.
- **Study & Work Session Tracking:** Enables users to monitor messaging sessions and track productivity during specific work intervals.
- **Web Interface Usability Research:** Serves as a technical reference for Computer Science students studying browser extension architectures, DOM virtualization handling, and user interface state machines.

---

## ⚠️ Limitations & Platform Restrictions

SnapAuto is designed with strict adherence to platform boundaries and transparently documents the following limitations:

- **Desktop Browser Scope:** Operates exclusively within supported desktop Chromium browsers (Google Chrome, Microsoft Edge, Brave) on `https://web.snapchat.com`.
- **Mobile-Only Snaps:** Snaps that require mobile-specific hardware capabilities (e.g., device sensors, native AR lenses) cannot be rendered or opened on Snapchat Web. SnapAuto identifies these labels, logs a notice, and pauses for the user rather than getting caught in endless retries.
- **DOM Structure Changes:** Snapchat Web may periodically alter internal HTML class names or structural hierarchies during platform updates. While SnapAuto relies primarily on semantic ARIA roles and text walker APIs, major platform revisions may require selector updates.
- **Platform Rate Limits:** Rapid successive requests are subject to Snapchat's server-side rate limits. Users should keep the built-in pacing cooldown enabled.

---

## 🔮 Future Enhancements

- [ ] Export session statistics to CSV/JSON for personal analytics.
- [ ] Customizable theme colors and HUD opacity sliders.
- [ ] Audio chime alerts upon detecting high-priority friend messages.
- [ ] Support for keyboard shortcut toggles (`Ctrl+Shift+S`) to toggle HUD visibility.
- [ ] Localization support for multiple languages.

---

## 📜 Project Disclaimer

> **IMPORTANT DISCLAIMER:**
> SnapAuto is an independent, open-source educational project developed solely for technical study, portfolio presentation, and browser ergonomics.
> 
> This project is **NOT** affiliated with, endorsed by, sponsored by, or officially associated with **Snapchat**, **Snap Inc.**, or any of their subsidiaries or affiliates. The official Snapchat website can be accessed at [https://www.snapchat.com](https://www.snapchat.com).
> 
> All trademarks, service marks, trade names, product names, and logos appearing in this project are the property of their respective owners. SnapAuto does not circumvent access controls, defeat security mechanisms, or publish unauthorized botting tools.

---

## 📄 License

This project is licensed under the **MIT License** — see the [LICENSE](LICENSE) file for complete details.

---

### 👨‍💻 Author

**Gokulraj A R**
- GitHub: [@gokulrajofficial7](https://github.com/gokulrajofficial7)
- Computer Science & Engineering
