import * as React from 'react';

export function useMediaQuery(query: string): boolean {
  const get = () => (typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : true);
  const [matches, setMatches] = React.useState(get);
  React.useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(query);
    const update = () => setMatches(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, [query]);
  return matches;
}
