// 发布栏：草稿存好后，预览给指定微信号 → 确认无误再发布或群发。发布、群发默认需要二次确认。
import { useState } from 'react';
import { Eye, Loader2, Megaphone, Rocket, TriangleAlert } from 'lucide-react';
import { confirmCopy, gate, type PublishKind } from './flow';
import { freePublish, getAccessToken, massSendAll, sendPreview } from './wechat';
import { tauriHttp } from './net';
import type { WxCred } from './config';

export interface DraftRef { mediaId: string; title: string; kind: 'news' | 'newspic' }
type Msg = { kind: 'ok' | 'err'; text: string };

export function PublishBar({ cred, confirmOn, draft, previewed, onPreviewed, onDone, onMsg }: {
  cred: WxCred;
  confirmOn: boolean;
  draft: DraftRef | null;
  previewed: boolean;
  onPreviewed(): void;
  /** 群发或发布提交成功后：草稿不能再用了，由外面清掉 */
  onDone(): void;
  onMsg(m: Msg): void;
}) {
  const [busy, setBusy] = useState<PublishKind | ''>('');
  const [ask, setAsk] = useState<Exclude<PublishKind, 'preview'> | null>(null);

  async function act(kind: PublishKind, confirmed = false) {
    if (!draft) return;
    if (gate(kind, confirmOn, confirmed) === 'ask') { setAsk(kind as Exclude<PublishKind, 'preview'>); return; }
    setAsk(null);
    setBusy(kind);
    try {
      const token = await getAccessToken(tauriHttp, cred.appId, cred.appSecret);
      if (kind === 'preview') {
        await sendPreview(tauriHttp, token, cred.previewWx, draft.mediaId);
        onPreviewed();
        onMsg({ kind: 'ok', text: `预览已发给微信号「${cred.previewWx}」，请打开手机微信查看（对方需要关注了这个公众号）` });
      } else if (kind === 'mass') {
        const r = await massSendAll(tauriHttp, token, draft.mediaId);
        onDone();
        onMsg({ kind: 'ok', text: `群发任务已提交（任务号 ${r.msgId || '未返回'}）。这只代表提交成功，实际送达以公众号后台为准；这份草稿已被微信删除` });
      } else {
        const r = await freePublish(tauriHttp, token, draft.mediaId);
        onDone();
        onMsg({ kind: 'ok', text: `发布任务已提交（任务号 ${r.publishId || '未返回'}）。这只代表提交成功，审核和发布结果请到公众号后台查看` });
      }
    } catch (e) {
      onMsg({ kind: 'err', text: e instanceof Error ? e.message : String(e) });
    }
    setBusy('');
  }

  const hasWx = !!cred.previewWx.trim();
  const copy = ask ? confirmCopy(ask, draft?.title ?? '', previewed) : null;
  return (
    <div className="wd-pub" aria-label="发布">
      <div className="wd-pub-hd">
        <b>发布</b>
        <span className="k-muted">{draft ? `草稿：《${draft.title}》${draft.kind === 'newspic' ? '（图片消息）' : ''}${previewed ? ' · 已发预览' : ''}` : '先把文章存到草稿箱'}</span>
      </div>
      <div className="wd-pub-btns">
        <button className="k-btn" disabled={!draft || !hasWx || busy !== ''} title={hasWx ? '' : '先在「公众号」设置里填预览微信号'} onClick={() => act('preview')}>
          {busy === 'preview' ? <Loader2 size={15} className="k-spin" /> : <Eye size={15} />}发预览
        </button>
        <button className="k-btn" disabled={!draft || busy !== ''} onClick={() => act('publish')}>
          {busy === 'publish' ? <Loader2 size={15} className="k-spin" /> : <Rocket size={15} />}发布
        </button>
        <button className="k-btn danger" disabled={!draft || busy !== '' || draft.kind === 'newspic'} title={draft?.kind === 'newspic' ? '图片消息能否用接口群发未核实，请用「发布」' : ''} onClick={() => act('mass')}>
          {busy === 'mass' ? <Loader2 size={15} className="k-spin" /> : <Megaphone size={15} />}群发
        </button>
      </div>
      {!hasWx && <p className="k-help">想先看预览，到「公众号」设置里填你自己的微信号（需要关注了这个公众号）。</p>}
      {copy && (
        <div className="wd-confirm" role="alertdialog" aria-label="二次确认">
          <TriangleAlert size={16} />
          <p>{copy.text}</p>
          <div className="wd-row">
            <button className="k-btn danger" onClick={() => act(ask!, true)}>{copy.button}</button>
            <button className="k-btn" onClick={() => setAsk(null)}>取消</button>
          </div>
        </div>
      )}
    </div>
  );
}
