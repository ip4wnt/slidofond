import { h } from './render.js';
import { svgIcon } from './icons.js';

// Открывает полноэкранную галерею слайдов. slides: [{previewUrl, title, description}], startIndex опционален.
// Возвращает функцию close().
export function openGallery(slides, startIndex = 0, options = {}) {
  let index = startIndex;
  const overlay = h('div', { class: 'gallery-overlay', role: 'dialog', 'aria-modal': 'true' });

  function close() {
    overlay.remove();
    document.removeEventListener('keydown', onKeydown);
  }

  function onKeydown(e) {
    if (e.key === 'Escape') close();
    if (e.key === 'ArrowRight') go(1);
    if (e.key === 'ArrowLeft') go(-1);
  }

  function go(delta) {
    index = (index + delta + slides.length) % slides.length;
    render();
  }

  function render() {
    const slide = slides[index];
    overlay.replaceChildren(
      h('div', { class: 'gallery-top' }, [
        h('div', { class: 'gallery-top-info' }, `Слайд ${index + 1} из ${slides.length}`),
        h('button', { class: 'icon-btn', onClick: close, 'aria-label': 'Закрыть', 'data-testid': 'button-close-gallery' }, [
          svgIcon('x'),
        ]),
      ]),
      h('div', { class: 'gallery-main' }, [
        slides.length > 1 &&
          h('button', { class: 'gallery-nav prev', onClick: () => go(-1), 'aria-label': 'Предыдущий слайд' }, [
            svgIcon('back'),
          ]),
        h('img', { src: slide.previewUrl, alt: slide.title || 'Слайд' }),
        slides.length > 1 &&
          h('button', { class: 'gallery-nav next', onClick: () => go(1), 'aria-label': 'Следующий слайд' }, [
            (() => {
              const el = svgIcon('back');
              el.style.transform = 'rotate(180deg)';
              return el;
            })(),
          ]),
      ]),
      (slide.title || slide.description) &&
        h('div', { class: 'gallery-caption' }, [
          slide.title && h('strong', {}, slide.title),
          slide.description && h('div', {}, slide.description),
        ]),
      slides.length > 1 &&
        h(
          'div',
          { class: 'gallery-thumbs' },
          slides.map((s, i) =>
            h('div', {
              class: `gallery-thumb ${i === index ? 'active' : ''}`,
              onClick: () => {
                index = i;
                render();
              },
            }, [h('img', { src: s.previewUrl, loading: 'lazy' })])
          )
        )
    );
  }

  render();
  document.addEventListener('keydown', onKeydown);
  document.body.appendChild(overlay);
  return close;
}
