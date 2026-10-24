 # Banter

**A simple, offline-friendly PWA for live music performers.**

Banter is a lightweight web app for keeping track of the things you want to say between songs - from introductions and guitar changes to birthdays, announcements, and the occasional joke.

Designed to be simple to use on a phone while performing, Banter keeps your prompts organised and close at hand, without needing an app store or a complicated setup.

## Features

- **Organised categories** — keep different types of banter in their own lists.
- **Quick access** — tap a phrase to mark it as used and keep track of what you've covered.
- **Easy editing** — add, edit, reorder, move, or copy phrases when connected to the server.
- **Bucket** — a permanent category for collecting phrases when deleting other categories.
- **Light and dark themes** — choose whichever works best for your environment.
- **Optional delay timer** — add a short pause before displaying returning to the categories.
- **Progressive Web App (PWA)** — install it on a compatible device and access cached content when offline.

## Installation

Banter is a small PHP-based web application. It can be hosted on a suitable PHP-enabled web server or run locally.

1. Copy the project files to your web server.
2. Ensure the `data` directory and its JSON files are readable by the web server.
3. Configure the save token in `assets/banter-config.php` and ensure the server can write the data files.
4. Open Banter in a browser and install it on your device if you wish.

Editing and saving require a connection to the server. Cached content can still be used offline, but **offline editing is not supported**.

## Data

Categories and phrases are stored in JSON files in the `data` directory. This keeps the content simple, portable, and easy to back up.

Back up your data before making changes directly to the JSON files. The optional `renumber_banter.sh` helper can reset category and phrase IDs, creating a backup before it writes changes.

## Built with

- HTML, CSS and JavaScript
- PHP for server-side saving
- JSON for data storage
- SortableJS for drag-and-drop reordering
- Service workers for offline caching and PWA support

## Philosophy

Banter aims to do one job well: help performers remember what they want to say, without getting in the way of the performance.

Keep it simple, keep it useful, and keep the show moving.

