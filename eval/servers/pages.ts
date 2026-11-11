export const SITE = 'https://docs.example.test/';

/**
 * The docs site, served by the stdio web server and seeded into every eval task. Each page
 * carries a marker word so a success check can tell its content was really copied.
 */
export const PAGES: Record<string, string> = {
  [`${SITE}release-notes`]:
    'Release notes for version 3.2 of the notes app, filed under RELEASE-32. Notes now sync between devices within a few seconds. Search finds words inside attached files. The editor keeps your place when you switch notebooks. Exporting a notebook to plain text no longer drops the last line.',
  [`${SITE}corrections`]:
    'Corrections for the launch post. Sync arrives on Thursday 14 May, not Tuesday 12 May. The free plan keeps 50 notes, not 20. When these are in, the post is marked CORRECTED.',
  [`${SITE}style-a`]:
    'Style guide, part one (STYLE-A). Write short sentences. Prefer the active voice. Spell out numbers below ten.',
  [`${SITE}style-b`]:
    'Style guide, part two (STYLE-B). Headings use sentence case. Write dates as 14 May 2026. Leave out exclamation marks.',
};
