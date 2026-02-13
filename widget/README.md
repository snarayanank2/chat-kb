# widget

Embeddable JavaScript chat widget (`widget.js`) for third-party sites.

## Quick embed

```html
<script
  src="https://YOUR_WIDGET_HOST/widget.js"
  data-project-handle="my-project-handle"
  data-api-base="https://YOUR_PROJECT_REF.supabase.co/functions/v1"
  data-position="right"
  data-primary-color="#2563eb"
  data-title="Docs Assistant"
  data-welcome-text="Ask anything about our docs."
></script>
```

## Responsibilities (Phase 5)

- Floating bubble + expandable panel UI.
- Session bootstrap flow (`embed_session` then `chat`).
- Friendly error states for:
  - blocked origin
  - rate limited
  - quota exceeded
  - temporary failure
- Citation chips rendered on assistant answers.
- Basic theming:
  - position (`left` or `right`)
  - primary color
  - title
  - welcome text
  - launcher label
  - input placeholder

## Configuration options

You can pass options via `data-*` attributes or `window.ChatKBWidgetOptions` before loading script.

- `projectHandle` / `data-project-handle` (required)
- `apiBase` / `data-api-base` (required if not inferable)
- `position` / `data-position`
- `primaryColor` / `data-primary-color`
- `title` / `data-title`
- `welcomeText` / `data-welcome-text`
- `launcherLabel` / `data-launcher-label`
- `placeholder` / `data-placeholder`

## Global API

After load, the widget exposes:

- `window.ChatKBWidget.open()`
- `window.ChatKBWidget.close()`
- `window.ChatKBWidget.destroy()`
