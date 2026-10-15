import { useEffect } from 'react';
import { memorySaverEnabled, subscribeMemorySaver } from './memorySaver.js';
import { manageMediaMemory } from './mediaMemory.js';

export default function useMediaMemory(ref, source) {
  useEffect(() => {
    const element = ref.current;
    if (!element || !source) return;
    const manager = manageMediaMemory(element, source, { observe: element.parentElement });
    const sync = () => manager.setEnabled(memorySaverEnabled());
    sync();
    const unsubscribe = subscribeMemorySaver(sync);
    return () => { unsubscribe(); manager.dispose(); };
  }, [ref, source]);
}
