---
name: playwright
description: Browser automation via Playwright MCP. Use for web scraping, form filling, UI testing, taking screenshots, and any task requiring browser interaction.
---

# Playwright Browser Automation

A headless Chromium browser is available via the `playwright` MCP. Use it to navigate web pages, interact with elements, extract content, and take screenshots.

## How It Works

The MCP uses **accessibility snapshots** by default (not screenshots). Each snapshot gives a structured tree of interactive elements with `ref` IDs you use for interactions. This is faster and more reliable than coordinate-based clicks.

## Core Workflow

1. `browser_navigate` → open a URL
2. `browser_snapshot` → get the accessibility tree to see elements and their refs
3. Interact using refs from the snapshot
4. `browser_snapshot` again to verify state changes

## Available Tools

### Navigation
| Tool | Description |
|------|-------------|
| `browser_navigate` | Navigate to a URL |
| `browser_back` | Go back in history |
| `browser_forward` | Go forward in history |
| `browser_reload` | Reload the page |

### Inspection
| Tool | Description |
|------|-------------|
| `browser_snapshot` | Get accessibility tree (refs for interactions) |
| `browser_screenshot` | Take a screenshot (PNG) |
| `browser_evaluate` | Execute JavaScript and return result |

### Interaction
| Tool | Description |
|------|-------------|
| `browser_click` | Click an element by ref |
| `browser_type` | Type text into focused element |
| `browser_fill` | Fill an input field by ref |
| `browser_select_option` | Select a dropdown option by ref |
| `browser_check` | Check a checkbox by ref |
| `browser_uncheck` | Uncheck a checkbox by ref |
| `browser_hover` | Hover over an element by ref |
| `browser_press_key` | Press a keyboard key (e.g. `Enter`, `Tab`, `Escape`) |
| `browser_drag` | Drag from one element to another |

### Page Management
| Tool | Description |
|------|-------------|
| `browser_tab_new` | Open a new tab |
| `browser_tab_list` | List all open tabs |
| `browser_tab_select` | Switch to a tab by ID |
| `browser_tab_close` | Close a tab |
| `browser_close` | Close the current page |

### Files & Output
| Tool | Description |
|------|-------------|
| `browser_file_upload` | Upload a file to an input[type=file] |
| `browser_pdf_save` | Save the page as PDF |
| `browser_wait_for_selector` | Wait until an element appears |

### Dialogs
| Tool | Description |
|------|-------------|
| `browser_handle_dialog` | Accept or dismiss an alert/confirm/prompt dialog |

## Practical Examples

### Scrape a webpage
```
browser_navigate(url="https://example.com")
browser_snapshot()   # read structure, find content
browser_evaluate(expression="document.querySelector('article').innerText")
```

### Fill and submit a form
```
browser_navigate(url="https://example.com/contact")
browser_snapshot()                          # find field refs
browser_fill(ref="ref_5", value="John")    # fill name field
browser_fill(ref="ref_6", value="john@example.com")
browser_click(ref="ref_10")               # click Submit button
browser_snapshot()                          # verify success message
```

### Take a screenshot
```
browser_navigate(url="https://example.com")
browser_screenshot()   # returns base64 PNG
```

### Execute JavaScript
```
browser_navigate(url="https://example.com")
browser_evaluate(expression="JSON.stringify(window.__NEXT_DATA__)")
```

### Handle login with cookies
```
browser_navigate(url="https://example.com/login")
browser_snapshot()
browser_fill(ref="ref_2", value="username")
browser_fill(ref="ref_3", value="password")
browser_click(ref="ref_4")   # submit
browser_snapshot()            # verify logged in
```

## Best Practices

- Always call `browser_snapshot` before interacting — refs change after navigation or page updates
- Prefer `browser_fill` over `browser_click` + `browser_type` for form inputs
- Use `browser_evaluate` for complex DOM extraction — it's faster than parsing the full snapshot
- After clicking buttons that trigger navigation, call `browser_snapshot` to confirm new page loaded
- For SPAs, use `browser_wait_for_selector` to wait for dynamic content to appear
- Use multiple tabs (`browser_tab_new`) when you need to compare pages or keep context

## Notes

- The browser runs in headless mode — no display is required
- Sessions persist across tool calls within the same Claude session
- JavaScript errors and console output are not automatically captured; use `browser_evaluate` with try/catch to surface them
- CAPTCHA and bot-detection may block automated browsers on some sites
