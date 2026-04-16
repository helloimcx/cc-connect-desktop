---
name: knowledge-base
description: Search selected knowledge bases through the local AI-WorkStation knowledge API.
---

Use this skill when the user message includes a `[Selected Knowledge Bases]` block.

- Only search the knowledge bases listed in that block.
- Prefer the bundled script `./scripts/search-knowledge.sh` instead of writing inline `curl`.
- Call the script with the user question first, followed by one or more knowledge-base IDs.
- If the script reports `No results`, tell the user the selected knowledge bases did not contain relevant content.
- If the script reports `Error: ...`, tell the user the knowledge search failed and avoid claiming retrieved facts.
- When you answer from retrieved content, cite the matching knowledge base title or file name shown by the script.
