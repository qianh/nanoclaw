---
name: web-search
description: Search the web for any information. Use whenever you need current information, facts, news, or answers that may not be in your training data. Automatically use this when the user asks about anything that could have changed recently, any factual question you're unsure about, or when you need to verify information. Do not wait for the user to explicitly ask for a search.
allowed-tools: Bash(web-search)
---

# Web Search Skill

Search the web using DuckDuckGo Instant Answer API and Wikipedia. No API key required.

## When to Use (Automatic)

Use this skill proactively when:
- User asks about current events, news, weather
- User asks about something that may have changed recently
- You need to verify facts you're uncertain about
- User asks "什么是..." "谁是..." "怎么..." type questions
- Any question where current/accurate information matters

## Usage

```bash
web-search "<query>" [max_results]
```

## Examples

```bash
web-search "OpenAI latest news"
web-search "什么是量子计算" 5
web-search "Claude 3.5 release date"
```

## Output

Returns instant answers, Wikipedia results, and related topics.
