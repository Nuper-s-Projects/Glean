import { useSyncExternalStore } from 'react';
import { memorySaverEnabled, subscribeMemorySaver } from './memorySaver.js';

export default function useMemorySaver() {
  return useSyncExternalStore(subscribeMemorySaver, memorySaverEnabled, () => false);
}
