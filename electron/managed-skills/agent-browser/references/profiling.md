# Profiling

Capture Chrome DevTools performance profiles during browser automation for performance analysis.

**Related**: [commands.md](commands.md) for full command reference, [SKILL.md](../SKILL.md) for quick start.

## Basic Profiling

```bash
# Start profiling
agent-browser profiler start

# Perform actions
agent-browser navigate https://example.com
agent-browser click "#button"
agent-browser wait 1000

# Stop and save
agent-browser profiler stop ./trace.json
```
