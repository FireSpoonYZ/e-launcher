import { Capacitor } from '@capacitor/core';
import { File, X } from 'lucide-react';
import { Device, type Attachment } from './native';
import { ErrorNotice, useAction, useText } from './ui';

function formatBytes(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

export function AttachmentList({attachments, sent=false, remove}: {attachments:Attachment[]; sent?:boolean; remove?:(id:string)=>void}) {
  const t=useText(); const action=useAction();
  return <><div className={`attachments ${sent?'sent':''}`}>{attachments.map(item => item.kind === 'image'
    ? <div className="image-attachment" key={item.id}><button aria-label={t('查看图片','View image')} onClick={()=>action.run(()=>Device.openAttachment({attachmentId:item.id}))}><img src={Capacitor.convertFileSrc(item.path)} alt={item.name}/></button>{remove&&<button className="remove-attachment" aria-label={t('移除附件','Remove attachment')} onClick={()=>remove(item.id)}><X/></button>}</div>
    : <div className="file-attachment" key={item.id}><button className="file-open" disabled={!sent} onClick={()=>sent&&action.run(()=>Device.openAttachment({attachmentId:item.id}))}><File/><span><strong>{item.name}</strong><small>{item.mimeType} · {formatBytes(item.size)}</small></span></button>{remove&&<button className="remove-file" aria-label={t('移除附件','Remove attachment')} onClick={()=>remove(item.id)}><X/></button>}</div>)}</div><ErrorNotice error={action.error}/></>;
}
