// The "Last updated" line on the legal pages. Each page declares its own date as an ISO
// string so bun run check-legal-dates can read it without parsing prose, and renders it
// through the formatter below so both pages read the same way.
export function formatLastUpdated(iso: string): string {
    return new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC',
    })
}
