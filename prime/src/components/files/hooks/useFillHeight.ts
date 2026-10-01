import * as React from 'react';
import { fillHeight } from '../logic/fillHeight';

const DESKTOP = '(min-width: 768px)';

// useFillHeight returns a height (px) for ref's element so it fills the
// window from where it starts down to bottomGap above the bottom edge, or
// undefined on phones, where the page keeps scrolling normally. It re-measures
// on window resize and when anything above the card changes height (banners,
// status lines), via a ResizeObserver on the card's parent.
export function useFillHeight(ref: React.RefObject<HTMLElement>, bottomGap: number): number | undefined {
  const [height, setHeight] = React.useState<number | undefined>(undefined);

  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const desktop = typeof window.matchMedia === 'function' ? window.matchMedia(DESKTOP).matches : true;
      if (!desktop) {
        setHeight(undefined);
        return;
      }
      // Document offset, so a page scrolled for any reason doesn't skew it.
      const top = el.getBoundingClientRect().top + window.scrollY;
      setHeight(fillHeight(window.innerHeight, top, bottomGap));
    };
    measure();
    window.addEventListener('resize', measure);
    const ro = typeof ResizeObserver === 'function' && el.parentElement ? new ResizeObserver(measure) : null;
    if (ro && el.parentElement) ro.observe(el.parentElement);
    return () => {
      window.removeEventListener('resize', measure);
      ro?.disconnect();
    };
  }, [ref, bottomGap]);

  return height;
}
