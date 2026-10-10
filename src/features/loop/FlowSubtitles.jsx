import { useEffect, useRef, useState } from 'react';

// Keep the browser's WebVTT clock, but position Flow's text outside its overlays.
export default function FlowSubtitles({ video, enabled, source }) {
  const [text,setText]=useState('');
  const panel=useRef(null);
  useEffect(()=>{
    const element=video.current, tracks=element.textTracks;
    const attached=new Set();
    const sync=()=>{
      const lines=[];
      for(const track of tracks) if(track.kind==='captions' && track.mode!=='disabled') {
        for(const cue of track.activeCues || []) lines.push(cue.getCueAsHTML().textContent);
      }
      setText(enabled ? lines.join('\n') : '');
    };
    const bind=()=>{
      for(const track of tracks) if(track.kind==='captions' && !attached.has(track)) {attached.add(track);track.addEventListener('cuechange',sync);}
      sync();
    };
    setText('');bind();tracks.addEventListener('addtrack',bind);tracks.addEventListener('change',bind);
    element.addEventListener('loadeddata',sync);element.addEventListener('seeked',sync);
    return()=>{tracks.removeEventListener('addtrack',bind);tracks.removeEventListener('change',bind);element.removeEventListener('loadeddata',sync);element.removeEventListener('seeked',sync);for(const track of attached)track.removeEventListener('cuechange',sync);};
  },[video,enabled,source]);
  useEffect(()=>{
    const node=panel.current, stage=node.closest('.loop-flow-stage');
    if(!stage)return;
    stage.classList.toggle('has-flow-captions',Boolean(enabled && source));
    const description=stage.querySelector('.loop-flow-caption'), actions=stage.querySelector('.loop-flow-actions'), seek=stage.querySelector('.loop-flow-seek');
    let frame;
    const measure=()=>{
      const box=stage.getBoundingClientRect();
      if(box.height<500 && box.width>500) {
        // Landscape places subtitles beside the description rather than above it.
        stage.style.removeProperty('--flow-description-max-height');
        stage.style.removeProperty('--flow-caption-max-height');
        return;
      }
      const topControls=[stage.querySelector('.loop-flow-sound'),stage.querySelector('.loop-caption-controls')].filter(Boolean);
      const top=Math.max(box.top+16,...topControls.map(control=>control.getBoundingClientRect().bottom))+12;
      const content=description?.querySelector(':scope > p');
      const descriptionBox=description?.getBoundingClientRect();
      const baseline=parseFloat(getComputedStyle(node).lineHeight)*(box.height<500 ? 1 : 2);
      const reserve=enabled && source ? Math.max(node.getBoundingClientRect().height,baseline)+18 : 0;
      if(reserve && descriptionBox) {
        const available=Math.max(32,descriptionBox.bottom-top-reserve);
        const fixed=descriptionBox.height-(content?.getBoundingClientRect().height || 0);
        stage.style.setProperty('--flow-description-max-height',`${Math.max(24,available-fixed)}px`);
        stage.style.setProperty('--flow-caption-max-height',`${available}px`);
      } else {stage.style.removeProperty('--flow-description-max-height');stage.style.removeProperty('--flow-caption-max-height');}
      const boundary=Math.min(description?.getBoundingClientRect().top ?? box.bottom,seek?.getBoundingClientRect().top ?? box.bottom);
      const side=actions?.getBoundingClientRect();
      const vertical=actions && getComputedStyle(actions).display==='grid';
      node.style.setProperty('--subtitle-bottom',`${Math.max(16,box.bottom-boundary+12)}px`);
      node.style.setProperty('--subtitle-right',`${vertical && side ? Math.max(16,box.right-side.left+12) : 16}px`);
    };
    const schedule=()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(measure);};
    const observer=new ResizeObserver(schedule);
    for(const target of [stage,description,actions,seek,node,stage.querySelector('.loop-caption-controls')])if(target)observer.observe(target);
    measure();
    return()=>{cancelAnimationFrame(frame);observer.disconnect();stage.classList.remove('has-flow-captions');stage.style.removeProperty('--flow-description-max-height');stage.style.removeProperty('--flow-caption-max-height');};
  },[enabled,source]);
  return <div ref={panel} className="loop-flow-subtitles" aria-label="Video subtitles" aria-live="off">{enabled && text ? <span>{text}</span> : null}</div>;
}
