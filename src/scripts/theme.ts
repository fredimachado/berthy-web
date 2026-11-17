// Theme toggle. The no-flash initialisation runs inline in <head> (BaseLayout); this wires the buttons.
const KEY = 'berthy-theme';
const root = document.documentElement;
const media = matchMedia('(prefers-color-scheme: dark)');

function stored(): 'light' | 'dark' | null {
  try {
    const value = localStorage.getItem(KEY);
    return value === 'light' || value === 'dark' ? value : null;
  } catch {
    return null;
  }
}

function sync() {
  const dark = root.classList.contains('dark');
  document.querySelectorAll<HTMLElement>('[data-theme-toggle]').forEach((button) => {
    button.setAttribute('aria-pressed', String(dark));
    button.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
  });
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', dark ? '#0b0a12' : '#fdfcff');
}

function apply(dark: boolean) {
  root.classList.toggle('dark', dark);
  sync();
}

document.addEventListener('click', (event) => {
  if (!(event.target as Element).closest('[data-theme-toggle]')) return;
  const dark = !root.classList.contains('dark');
  apply(dark);
  try {
    localStorage.setItem(KEY, dark ? 'dark' : 'light');
  } catch {
    /* private mode: the choice lasts for this page only */
  }
});

media.addEventListener('change', (event) => {
  if (!stored()) apply(event.matches);
});

sync();
