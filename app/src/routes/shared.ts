export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export function shell(title: string, body: string, actions = ''): string {
  return `
    <div class="page">
      <header class="page-header">
        <div class="page-header__start">
          <a class="brand" href="/">iwa-ssh</a>
          <h1>${escapeHtml(title)}</h1>
        </div>
        <nav class="page-header__actions">${actions}</nav>
      </header>
      <main class="page-body">${body}</main>
    </div>
  `;
}
