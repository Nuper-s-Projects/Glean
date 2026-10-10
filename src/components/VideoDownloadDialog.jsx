import { useEffect, useId, useRef, useState } from 'react';
import { apiRequest } from '../app/apiClient';

const busy = job => job && ['queued','fetching','downloading','processing'].includes(job.status);
const labels = {queued:'Waiting for a download slot…',fetching:'Checking the video link…',downloading:'Downloading video…',processing:'Preparing your MP4…',ready:'Ready to save',cancelled:'Download cancelled',expired:'This prepared video expired. Prepare it again to download.'};
const duration = seconds => Number.isFinite(seconds) ? `${Math.floor(seconds/60)}:${String(Math.floor(seconds%60)).padStart(2,'0')}` : '';

export default function VideoDownloadDialog({ onClose, onAddAsMedia, returnFocus }) {
  const dialog = useRef(null), input = useRef(null), request = useRef(null), locked = useRef(false);
  const title = useId();
  const [url,setUrl] = useState(''), [job,setJob] = useState(null), [error,setError] = useState(''), [submitting,setSubmitting] = useState(false), [adding,setAdding] = useState(false), [loading,setLoading] = useState(true);
  useEffect(()=>{
    if(job?.status!=='ready')return;
    const timer=setTimeout(()=>setJob(current=>current?.id===job.id?{...current,status:'expired'}:current),Math.max(0,job.expiresAt-Date.now()));
    return ()=>clearTimeout(timer);
  },[job?.id,job?.status,job?.expiresAt]);
  useEffect(()=>{
    const previous=returnFocus || document.activeElement,element=dialog.current;
    element.showModal();input.current.focus();
    const controller=new AbortController();
    apiRequest('/video-downloads',{signal:controller.signal,retries:0}).then(data=>{
      const recent=data.jobs.find(item=>busy(item)||item.status==='ready');
      if(recent)setJob(recent);
    }).catch(error=>{if(!controller.signal.aborted)setError(error.message);}).finally(()=>{if(!controller.signal.aborted)setLoading(false);});
    return ()=>{controller.abort();request.current?.abort();element.close();if(previous?.isConnected)previous.focus({preventScroll:true});};
  },[]);
  useEffect(()=>{
    if(!busy(job))return;
    const controller=new AbortController();let timer;
    const poll=async()=>{
      try {
        const data=await apiRequest(`/video-downloads/${job.id}`,{signal:controller.signal,retries:0});
        if(controller.signal.aborted)return;
        setJob(data.job);setError('');
        if(busy(data.job))timer=setTimeout(poll,1500);
      }catch(error){if(!controller.signal.aborted){setError(error.message);timer=setTimeout(poll,4000);}}
    };
    timer=setTimeout(poll,1000);
    return ()=>{controller.abort();clearTimeout(timer);};
  },[job?.id,busy(job)]);
  const prepare=async event=>{
    event.preventDefault();if(locked.current||busy(job)||loading)return;
    locked.current=true;setSubmitting(true);setError('');
    const controller=new AbortController();request.current=controller;
    try {const data=await apiRequest('/video-downloads',{method:'POST',body:JSON.stringify({url:url.trim()}),signal:controller.signal});setJob(data.job);}
    catch(error){if(!controller.signal.aborted)setError(error.message);}
    finally {locked.current=false;if(!controller.signal.aborted)setSubmitting(false);}
  };
  const cancel=async()=>{
    if(locked.current)return;locked.current=true;setSubmitting(true);setError('');
    const controller=new AbortController();request.current=controller;
    try {const data=await apiRequest(`/video-downloads/${job.id}`,{method:'DELETE',signal:controller.signal});setJob(data.job);}
    catch(error){if(!controller.signal.aborted)setError(error.message);}
    finally {locked.current=false;if(!controller.signal.aborted)setSubmitting(false);}
  };
  const addAsMedia=async()=>{
    if(job?.status!=='ready'||locked.current||!onAddAsMedia)return;
    locked.current=true;setAdding(true);setError('');
    const controller=new AbortController();request.current=controller;
    try {
      const data=await apiRequest(`/video-downloads/${job.id}`,{signal:controller.signal,retries:0});
      if(controller.signal.aborted)return;
      const prepared=data.job;
      if(prepared?.status!=='ready'||prepared.expiresAt<=Date.now())throw new Error('This prepared video expired. Prepare it again to add it.');
      const base=(prepared.title||'video').normalize('NFKD').replace(/[^\w.-]+/g,'_').replace(/^\.+|\.+$/g,'').slice(0,100)||'video';
      const file={downloadId:prepared.id,previewUrl:prepared.previewUrl,expiresAt:prepared.expiresAt,name:`${base.replace(/\.mp4$/i,'')}.mp4`,type:'video/mp4',size:prepared.size,lastModified:0};
      await onAddAsMedia(file);
      if(!controller.signal.aborted)onClose();
    } catch(failure) {if(!controller.signal.aborted)setError(failure.message||'Could not add this video to the post.');}
    finally {locked.current=false;if(!controller.signal.aborted)setAdding(false);}
  };
  const keyboard=event=>{
    if(event.key!=='Tab')return;
    const controls=[...dialog.current.querySelectorAll('button:not(:disabled),input:not(:disabled),a[href]')].filter(item=>item.getClientRects().length);
    const first=controls[0],last=controls.at(-1);
    if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
    else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
  };
  return <dialog ref={dialog} className="video-download-dialog" aria-labelledby={title} onKeyDown={keyboard} onCancel={event=>{event.preventDefault();onClose();}} onClick={event=>{if(event.target===event.currentTarget){const rect=event.currentTarget.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)onClose();}}}>
    <header><div><span className="video-download-kicker">Glean Loop</span><h2 id={title}>Download a video</h2></div><button type="button" className="video-download-close" aria-label="Close video downloader" onClick={onClose}>×</button></header>
    <p>Paste a public video link from YouTube, TikTok, Reddit, X, Instagram, or Vimeo, or a direct MP4 link.</p>
    <form onSubmit={prepare}><label htmlFor={`${title}-link`}>Video link</label><div className="video-download-input"><input ref={input} id={`${title}-link`} type="url" required maxLength={2048} placeholder="https://…" value={url} onChange={event=>setUrl(event.target.value)} disabled={loading||submitting||adding||busy(job)} autoComplete="off"/><button type="submit" className="primary-button" disabled={loading||submitting||adding||busy(job)||!url.trim()}>{loading?'Checking…':submitting?'Starting…':'Prepare video'}</button></div></form>
    {error ? <p className="video-download-error" role="alert">{error}</p> : null}
    {job ? <section className="video-download-result" aria-label="Video download status">
      {job.status==='ready' ? <video key={job.id} src={job.previewUrl} controls playsInline preload="metadata" aria-label="Downloaded video preview"/> : null}
      <strong>{job.title || 'Video'}</strong>
      {job.uploader || job.duration ? <small>{[job.uploader,duration(job.duration)].filter(Boolean).join(' · ')}</small> : null}
      <p role="status">{job.status==='failed' ? job.error : labels[job.status]}{job.status==='downloading' && job.progress!=null ? ` ${job.progress}%` : ''}</p>
      {busy(job) ? <><progress max="100" value={job.progress ?? undefined} aria-label="Video preparation progress"/><button type="button" onClick={cancel} disabled={submitting}>Cancel download</button><small>You can close this window. Preparation continues in the background.</small></> : null}
      {job.status==='ready' ? <><div className="video-download-actions"><button type="button" className="primary-button" disabled={adding||submitting||!onAddAsMedia} onClick={addAsMedia}>{adding?'Adding…':'Add as media'}</button><a className="primary-button" href={job.downloadUrl} download>Download MP4{job.size ? ` · ${(job.size/1024/1024).toFixed(1)} MB` : ''}</a></div><small>{adding?'Adding the video to this post…':'Choose Add as media to attach it to your post, or Download MP4 to save a copy without attaching it.'}</small><button type="button" disabled={submitting||adding} onClick={cancel}>Remove prepared video</button><small>Available for 30 minutes.</small></> : null}
    </section> : null}
    <footer>Up to 720p, 30 minutes and 300 MB. Only download videos you own or have permission to save. Private, live and protected videos are not supported.</footer>
  </dialog>;
}
