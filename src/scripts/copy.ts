// One handler for every copy button. A button names what to copy with either
// data-copy-text="..." or data-copy-from="<selector>" (searched inside the closest figure or
// [data-copy-root]). It gets data-copied for a moment and its screen-reader label changes.
const RESET_MS = 1800;

async function write(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false; // insecure context or permission denied: leave the button unchanged
  }
}

document.addEventListener('click', async (event) => {
  const button = (event.target as Element).closest<HTMLElement>(
    '[data-copy-text], [data-copy-from]',
  );
  if (!button) return;
  const root = button.closest('figure, [data-copy-root]') ?? document;
  const source = button.dataset.copyFrom ? root.querySelector(button.dataset.copyFrom) : null;
  const text = button.dataset.copyText ?? source?.textContent?.replace(/\n$/, '') ?? '';
  if (!text || !(await write(text))) return;

  const label = button.querySelector<HTMLElement>('[data-copy-label]');
  const before = label?.textContent;
  button.setAttribute('data-copied', '');
  if (label) label.textContent = 'Copied';
  window.setTimeout(() => {
    button.removeAttribute('data-copied');
    if (label && before) label.textContent = before;
  }, RESET_MS);
});
