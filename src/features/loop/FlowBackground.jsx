import { memo, useCallback, useEffect, useRef, useState } from 'react';
import PostAttachmentBackground from './PostAttachmentBackground';

function BackgroundLayer({ layer, onReady, onFailure }) {
  const ready = useCallback(() => onReady(layer.id), [layer.id, onReady]);
  const failure = useCallback(() => onFailure(layer.id), [layer.id, onFailure]);
  return <div className={`loop-flow-background-layer${layer.visible ? ' is-visible' : ''}`} data-background-url={layer.url}>
    <PostAttachmentBackground url={layer.url} mimeType={layer.mimeType} onReady={ready} onFailure={failure}/>
  </div>;
}

function FlowBackground({ media }) {
  const [layers, setLayers] = useState([]);
  const generation = useRef(0);
  const requested = useRef(null);
  const frames = useRef([]);
  const cleanup = useRef(null);
  const retire = useCallback(() => {
    clearTimeout(cleanup.current);
    cleanup.current = setTimeout(() => {
      // Preserve a newer image that is still loading when an older fade finishes.
      setLayers(current => current.filter(layer => layer.visible || !layer.ready));
    }, 720);
  }, []);
  const ready = useCallback(id => {
    if (requested.current !== id) return;
    // Paint the hidden incoming layer before starting its compositor transition.
    frames.current.push(requestAnimationFrame(() => {
      frames.current.push(requestAnimationFrame(() => {
        if (requested.current !== id) return;
        setLayers(current => current.map(layer => ({ ...layer,
          visible: layer.id === id, ready: layer.id === id || layer.ready,
        })));
        retire();
      }));
    }));
  }, [retire]);
  const failure = useCallback(id => {
    if (requested.current !== id) return;
    requested.current = null;
    setLayers(current => current.filter(layer => layer.id !== id).map(layer => ({ ...layer, visible: false })));
    retire();
  }, [retire]);
  const url = media?.url;
  const mimeType = media?.mimeType;
  useEffect(() => {
    frames.current.forEach(cancelAnimationFrame);
    frames.current = [];
    const id = ++generation.current;
    requested.current = url ? id : null;
    if (!url) {
      setLayers(current => current.filter(layer => layer.ready).map(layer => ({ ...layer, visible: false })));
      retire();
      return;
    }
    setLayers(current => [
      // Keep only the current backdrop plus one incoming image during the crossfade.
      // Fewer full-viewport blur surfaces reduce GPU memory and compositing work.
      ...current.filter(layer => layer.ready).slice(-1),
      { id, url, mimeType, ready: false, visible: false },
    ]);
  }, [url, mimeType, retire]);
  useEffect(() => () => {
    requested.current = null;
    clearTimeout(cleanup.current);
    frames.current.forEach(cancelAnimationFrame);
  }, []);
  if (!layers.length) return null;
  return <div className="loop-flow-backdrop" aria-hidden="true">
    {layers.map(layer => <BackgroundLayer key={layer.id} layer={layer} onReady={ready} onFailure={failure}/>)}
  </div>;
}

export default memo(FlowBackground);
