---
name: agent-browser
description: Browser automation for websites, Electron apps, and exploratory testing through the managed AI-WorkStation agent-browser tool.
---

Use this skill when the task requires browser or Electron UI automation, such as navigating sites, clicking buttons, filling forms, taking screenshots, collecting page data, or testing app flows.

- Always bootstrap the CLI syntax first with `./scripts/agent-browser.sh skills get agent-browser`.
- Prefer the bundled wrapper `./scripts/agent-browser.sh` over calling `agent-browser` from `PATH`.
- If the wrapper reports that the managed tool is unavailable, tell the user the built-in browser automation dependency is not ready on this machine.
- Keep browser actions explicit and incremental: inspect state, act, then verify.
- When the task is finished, close active browser sessions if you opened any.
