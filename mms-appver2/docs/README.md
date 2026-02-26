# MMS Documentation

This folder contains high-level documentation and a changelog for the MMS application.

How to use
- Edit this file to add usage notes, installation steps, or developer onboarding information.
- Use the `/docs` route in the running Next.js app to view these notes in the browser.

Changelog

## Unreleased
- 2026-02-26 — Documented the Superelectrode Search algorithm ('F' command): grouped anode (electrodes 1–3), cathode sweep from 4–N, ASCII packet format.
- 2025-10-28 — Added `/docs` route and starter documentation page.

## 2025-10-26
- Improved chart formatting (Y axis tick formatting and tooltip rounding).

Notes
- For richer rendering (Markdown -> HTML), you can extend `src/app/docs/page.tsx` to read and render this file using a Markdown renderer (e.g., `remark`, `react-markdown`).
