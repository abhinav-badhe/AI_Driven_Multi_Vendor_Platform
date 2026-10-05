# UI & Styling Guidelines (Next.js + Tailwind + shadcn/ui)

These rules govern all frontend/UI work in this repo. They exist for two reasons:
1. To lock in one styling approach (no mixing frameworks, no ad-hoc custom CSS).
2. To stop AI-generated interfaces from defaulting to a generic, bulky, "AI slop" look.

Read this file in full before writing or editing any component. If a request conflicts with this document, follow this document and flag the conflict.

---

## 1. Stack — do not deviate

This is a Next.js (App Router) project. Styling is **utility-first**, not custom CSS files, not CSS-in-JS.

| Layer | Use | Do NOT use |
|---|---|---|
| Styling engine | **Tailwind CSS v4** | Bootstrap, Bulma, Foundation, vanilla CSS modules for layout |
| Component primitives | **shadcn/ui** (copied into `/components/ui`, built on Radix/Base UI primitives) | Material UI, Chakra UI, Ant Design, Mantine |
| Runtime styling | None — Tailwind compiles to static CSS at build time | styled-components, Emotion, or any CSS-in-JS |
| Icons | `lucide-react` | Font Awesome, emoji-as-icons, inline hand-drawn SVGs |
| Forms | React Hook Form + Zod (or TanStack Form + Zod) | Uncontrolled ad-hoc forms, custom validation logic |
| Tables / data grids | TanStack Table (headless) styled with shadcn primitives | Any pre-themed "admin template" table plugin |
| Charts | Recharts directly, or Tremor's chart components (Recharts-based, shadcn-compatible) for fast KPI/analytics views | Chart.js, heavy D3 builds, Nivo (only if you specifically need exotic chart types) |
| Dark mode | `next-themes`, `attribute="class"`, driven by CSS variables | Manual `localStorage` theme toggling, duplicate style sheets |
| Toasts / command menu | `sonner`, `cmdk` (both shadcn-compatible) | Custom-built notification systems |

**Why this stack, specifically for SaaS:** Tailwind + shadcn/ui is the de facto default for Next.js SaaS apps because shadcn components live in your own codebase — you own and can restyle every line, there's no breaking-change upgrade risk, and it composes cleanly with React Server Components. CSS-in-JS libraries add runtime cost and fight RSC. Pre-themed kits (Bootstrap, MUI) fight you the moment you need a distinctive, non-templated look — which is exactly the problem this document is trying to prevent.

**Never introduce a second styling system.** No inline `style={{}}` for anything expressible in Tailwind. No new CSS file per component. If a one-off value is genuinely needed, use Tailwind's arbitrary value syntax (`w-[137px]`) rather than opening a `.module.css` file.

---

## 2. Project setup reference

```bash
npx create-next-app@latest . --typescript --tailwind --app
npx shadcn@latest init
npx shadcn@latest add button input card dialog dropdown-menu table form
```

- Tailwind v4 has **no `tailwind.config.js`**. All design tokens (colors, radius, spacing, fonts) are declared in CSS using `@theme` inside `app/globals.css`.
- Use `@theme` (not `@theme inline`) when the app supports multiple themes/dark mode — `@theme inline` bakes resolved values into utilities at build time and silently breaks runtime theme switching.
- Colors are defined in **OKLCH**, not hex/RGB — it's perceptually uniform, so lightening/darkening a token for dark mode doesn't warp its hue.
- Tailwind v4 defaults changed from v3: `ring` is now 1px (was 3px) and borders default to `currentColor` (was gray) — set border colors explicitly, don't assume gray.

```css
/* app/globals.css */
@import "tailwindcss";

@theme {
  --color-background: oklch(1 0 0);
  --color-foreground: oklch(0.15 0.01 260);
  --color-primary: oklch(0.55 0.18 250);   /* pick a real, deliberate hue — see §4 */
  --color-border: oklch(0.9 0.005 260);
  --radius: 0.5rem;                         /* see §4.2 — do not blanket-round everything larger */
}

@custom-variant dark (&:where([data-mode="dark"], [data-mode="dark"] *));
```

---

## 3. Design tokens (fill these in before building screens)

Define these once, at the start of the project, as deliberate choices — not framework defaults left untouched. This is the single biggest lever against a generic look.

- **Palette**: one neutral scale (background/foreground/border/muted) + **one** primary accent + semantic colors (success/warning/destructive). State the actual OKLCH or hex values here. Do not ship the unmodified shadcn "slate + default blue" theme as final.
- **Typography**: one typeface for UI text (a real choice, reasoned about — see §4.1), one monospace face reserved only for actual code/data, not decoration. Define a type scale (e.g. 12/13/14/16/20/24/32) and use it consistently — don't invent a new size per component.
- **Radius**: one base radius for controls (buttons, inputs, small cards), a slightly smaller or equal radius for containers/panels. Do not use one large radius (e.g. `rounded-2xl`) on every element regardless of size — see §4.2.
- **Spacing**: build on Tailwind's default 4px scale. Pick a standard content padding (e.g. `p-6` for cards, `p-4` for compact rows) and reuse it — don't vary padding arbitrarily between similar components.
- **Elevation**: decide once whether this product uses borders, shadows, or both to separate surfaces — see §4.3. Don't mix strategies screen to screen.

---

## 4. Hard rules: avoid the generic "AI-generated" look

AI design tools (and AI coding agents) converge on the same recognizable patterns because they're statistically the most common output in training data. These are now well catalogued as "AI slop" tells. Treat every rule below as a lint rule, not a suggestion.

### 4.1 Typography
- Do not leave the font as Tailwind/shadcn's default (Inter/Geist/system-ui) without a deliberate decision — pick a typeface (or pairing) intentionally, or explicitly keep the default because it's the right call for this product, not because nobody chose.
- No accenting a single word in a headline with italics, bold, or a color swap. It reads as a template fill-in, not emphasis.
- No tracked-out ALL-CAPS labels above headings or sections ("eyebrows"). If a section needs a category label, use normal sentence case at a smaller weight, or better — remove it and let the content stand on its own.
- Don't invent a new font size for every component. Stick to the defined type scale (§3).
- Keep line length under ~80 characters for body/paragraph text.

### 4.2 Borders, radius, shadows — "the SaaS-card kit"
This is the single most common bulky-AI-UI tell: every card, button, input, badge, and modal rounded to the same large radius, with an identical soft gray shadow underneath, regardless of hierarchy.
- Cards and panels: **cap radius around 8–12px.** Reserve full-pill rounding (`rounded-full`) for tags, badges, avatars, and pill-shaped buttons only — never for containers.
- Pick **one** elevation strategy per screen: either a hairline border (`border border-border`) *or* a subtle shadow (`shadow-sm`), not both stacked on every surface. A hairline border with a wide diffuse shadow underneath is a specific, recognizable "generated UI" signature — don't combine them.
- Never use heavy drop shadows (`shadow-xl`/`shadow-2xl` or custom large-blur shadows) on flat UI elements that don't visually float (dropdowns, popovers, and modals are the exception — they're meant to float above content).
- Don't apply identical shadow/radius/border treatment to every card on a dashboard. Vary treatment by hierarchy: a primary KPI card can look different from a secondary list row.

### 4.3 Color and gradients
- No default purple-to-blue gradient backgrounds (`from-purple-500 to-blue-500` or similar). This is the most recognizable AI-generated tell there is.
- No gradient text on headlines as a default treatment. If gradient text is used at all, it's one specific element on one specific page, not a repeated pattern.
- No glow effects (`box-shadow: 0 0 80px ...`) applied broadly. Glow, if used, is for a single specific moment of emphasis, not ambient decoration.
- No glassmorphism (`backdrop-filter: blur() + translucent white background`) stacked on more than one element per screen, if at all — SaaS product UI (as opposed to a marketing site) rarely needs it.
- Limit yourself to 2–4 deliberate visual "effects" per page total (one accent color used consistently counts as one). Everything else stays plain. Restraint reads as confidence; decoration-everywhere reads as generated.

### 4.4 Layout
- Avoid the reflexive 3-equal-column grid for features/stats/cards. If content genuinely has three unrelated peers, fine — but check first, and consider asymmetric splits (e.g. 60/40), varied card sizes, or a bento-style grid instead of forcing everything into equal boxes.
- Avoid centering everything by default. Dashboards and product UI are usually left-aligned, information-dense layouts — centered hero-style layouts belong on marketing pages, not inside the app.
- Numbered markers (01 / 02 / 03) are only appropriate when content is an actual sequence (steps, stages, a timeline). Don't add numbering as decoration.
- Don't add dividers, outlines, or extra visual structure that doesn't encode real information — every structural device should mean something.

### 4.5 Motion
- No blanket fade-and-slide-up entrance animation on every section/card on scroll or on load. This is a default, not a design decision, and it's immediately recognizable.
- No hover-lift/hover-shadow effect applied uniformly to every card, button, and row. If interactive affordance is needed, a simple, fast (~150ms) opacity or background-color change is enough.
- Motion should answer a user action (opening a panel, confirming a save, expanding a row) — not run automatically on page load or scroll.
- Respect `prefers-reduced-motion` for anything beyond micro-interactions.

### 4.6 SaaS-specific: density over "landing page" spaciousness
A very common failure mode: AI agents build **application UI** (dashboards, settings, tables, forms) with the generous whitespace and large type of a **marketing landing page**. These are different jobs.
- Product/app screens should default to compact, information-dense layouts: smaller type (13–14px body in dense tables/lists is normal), tighter row heights, and controls sized for repeated daily use — not oversized "hero" buttons and cards everywhere.
- Reserve large type, big whitespace, and hero treatment for genuinely marketing-facing pages (pricing, landing, onboarding welcome screens) — not the authenticated app shell.
- Sidebars, top bars, and toolbars should be compact and utilitarian, not decorative.
- Empty vertical space is not automatically "clean design" inside a data-heavy product — check whether it's hiding a lack of content decisions rather than adding polish.

---

## 5. Copy rules: no slogans, no eyebrows, no marketing fluff in product UI

AI agents building UI tend to write marketing copy where functional copy belongs — this is a major source of "bulky/unprofessional" feel. Product UI text should read like software, not an ad.

**Do not write, anywhere inside the authenticated application:**
- Taglines or slogans ("Empower your team to do more," "The future of X, today").
- Eyebrow labels above headings ("PRODUCTIVITY" above a heading that already says what it is).
- Generic filler adjectives: "innovative," "seamless," "powerful," "effortless," "cutting-edge," "revolutionary."
- Placeholder content that sounds fake in a real product: "John Doe," "Acme Inc.," "Lorem ipsum," round marketing-style numbers ("Increase efficiency by 47%").
- Restating the obvious above a component ("Here are your recent files:" above a file list that's clearly a file list).

**Do instead:**
- Name things the way the end user thinks about them, not how the system implements them. A user manages "notifications," not "webhook config."
- Use active voice, and keep the verb consistent through a flow: a button labeled "Publish" produces a toast that says "Published," not "Success" or "Done."
- Buttons say exactly what happens: "Save changes" not "Submit." "Delete project" not "Confirm." "Invite teammate" not "Add."
- Empty states are an instruction, not a mood: say what's missing and the one action that fills it ("No projects yet — create your first project" + a single clear CTA), not a decorative illustration with vague copy.
- Errors state what happened and how to fix it, in the interface's voice, without apologizing ("Card was declined. Try a different payment method." not "Oops! Something went wrong 😢").
- If a heading needs an eyebrow/label to be understood, the heading itself is under-written — fix the heading instead.

Marketing pages (landing, pricing) are the one place slogans and persuasive copy are appropriate — keep that copy out of the authenticated product shell entirely.

---

## 6. SaaS UI patterns

**Navigation**
- A fixed, compact sidebar (icon + label, collapsible to icon-only) is the standard SaaS pattern — not a marketing-style top nav inside the app.
- Keep nav item count visible without scrolling where possible; group secondary items under a "More" or settings section rather than expanding the list indefinitely.

**Dashboards / KPI cards**
- Lead with the number, not decoration. A KPI card is: label (small, muted) → value (large, one weight heavier) → delta/trend (small, colored only by semantic meaning — green/red tied to actual direction, not decoration).
- Don't wrap every KPI card in the same gradient or shadow treatment (§4.2–4.3).
- Use Tremor or Recharts for charts; keep chart chrome minimal — axis labels only where needed, no unnecessary gridlines, no legend when there's only one series.

**Data tables**
- Use TanStack Table (headless) + shadcn `Table` primitives. Support sorting, pagination, and column visibility for any table with meaningful row counts.
- Row height should be compact by default (dense mode), not spacious — this is a product surface, not a marketing list.
- Real, contextual empty states per table (see §5), never a generic spinner-forever or blank white box.

**Forms**
- React Hook Form + Zod for all forms with more than 1–2 fields. Validate on blur/submit, show inline field errors, not just a toast.
- Keep field labels above inputs (not floating labels for dense forms), and group related fields visually with spacing, not boxes-within-boxes.

**Settings / billing**
- Settings pages are a list of clearly labeled sections, not cards decorated like marketing feature blocks.
- Billing/plan UI: show real plan names and real prices, not "Plan A/B/C" placeholders, even in early development — placeholder-looking billing UI reads as untrustworthy.

**Loading states**
- Prefer skeleton loaders shaped like the real content over generic spinners, for anything above ~300ms load time.

---

## 7. Accessibility & quality floor (non-negotiable, regardless of visual style)

- Every interactive element has a visible keyboard focus state (don't remove Tailwind's focus ring without replacing it).
- Color is never the only signal for state (errors, success, required fields) — pair with an icon or text.
- Maintain WCAG AA contrast for text against its background, including inside colored badges/pills.
- Fully responsive down to mobile widths — dashboards should collapse to a usable single-column/drawer-nav layout, not just shrink.
- Respect `prefers-reduced-motion`.

---

## 8. Pre-ship checklist

Before considering a screen or component done, check it against this list:

- [ ] No default purple/blue gradient, no gradient text, no glow-on-everything
- [ ] Radius and shadow are consistent with the rest of the app, capped per §4.2, and not stacked (border + shadow) on the same flat element
- [ ] No ALL-CAPS eyebrow labels; no single-word-accented headlines
- [ ] No 3-equal-column layout used reflexively — check if the content actually calls for it
- [ ] No slogans, filler adjectives, or fake placeholder data anywhere in authenticated UI
- [ ] Buttons/CTAs name the exact action, in active voice, consistent with the resulting confirmation copy
- [ ] Density matches the surface: app/product screens are compact, not landing-page-spacious
- [ ] Motion is limited to responses to user action — no blanket scroll/load animations
- [ ] Keyboard focus is visible; contrast passes AA; layout works at mobile width
- [ ] Colors, type scale, spacing, and radius all pull from the tokens defined in §3 — nothing invented ad hoc
