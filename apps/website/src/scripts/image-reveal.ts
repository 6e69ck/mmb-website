const selector = '.progressive-image > img';

async function reveal(image: HTMLImageElement) {
  const frame = image.parentElement;
  if (frame?.hasAttribute('data-image-waiting')) {
    try {
      await image.decode();
      frame.dataset.imageReady = 'true';
    } catch {
      frame.removeAttribute('data-image-waiting');
    }
  }
  image.dataset.imageReady = 'true';
}

const observer = new IntersectionObserver(entries => {
  for (const entry of entries) {
    if (!entry.isIntersecting || !(entry.target instanceof HTMLImageElement)) continue;
    const image = entry.target;
    observer.unobserve(image);
    // Give cached and fast responses a chance to paint without a placeholder.
    window.setTimeout(() => {
      if (image.isConnected && !image.complete && !image.dataset.imageReady && image.parentElement) {
        image.parentElement.dataset.imageWaiting = 'true';
      }
    }, 80);
  }
});

function watch(image: HTMLImageElement) {
  if (image.complete && image.naturalWidth) void reveal(image);
  else if (image.matches(selector)) observer.observe(image);
}

document.addEventListener('load', event => {
  if (!(event.target instanceof HTMLImageElement)) return;
  observer.unobserve(event.target);
  void reveal(event.target);
}, true);

document.addEventListener('error', event => {
  if (!(event.target instanceof HTMLImageElement) || !event.target.matches(selector)) return;
  observer.unobserve(event.target);
  event.target.parentElement?.removeAttribute('data-image-waiting');
}, true);

document.querySelectorAll<HTMLImageElement>('img').forEach(watch);
new MutationObserver(records => {
  for (const record of records) {
    for (const node of record.addedNodes) {
      if (node instanceof HTMLImageElement) watch(node);
      else if (node instanceof Element) node.querySelectorAll<HTMLImageElement>(selector).forEach(watch);
    }
    for (const node of record.removedNodes) {
      if (node instanceof HTMLImageElement) observer.unobserve(node);
      else if (node instanceof Element) node.querySelectorAll<HTMLImageElement>(selector).forEach(image => observer.unobserve(image));
    }
  }
}).observe(document.body, { childList: true, subtree: true });
