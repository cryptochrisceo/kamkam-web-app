'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { api, mediaUrl } from '@/lib/api';
import { compact, timeAgo } from '@/lib/format';
import { H, s } from '@/lib/ui';
import { useAsync } from '@/hooks/useAsync';
import { useViewport } from '@/hooks/useViewport';
import { useApp } from '@/components/AppProvider';
import { Avatar, CloseBtn, Empty, ErrorBox, GiftIcon, Modal, Skeleton, Spinner, Tabs, Verified } from '@/components/ui';
import { FollowButton } from '@/components/FollowButton';
import { PostCard } from '@/components/PostCard';
import type { Profile, PublicUser } from '@/types';

export default function ProfilePage() {
  const { username } = useParams<{ username: string }>();
  const router = useRouter();
  const search = useSearchParams();
  const { openGift, showToast, upsertPosts, posts: store } = useApp();
  const prof = useAsync(() => api.profile(username).then(r => r.user), [username]);
  const [tab, setTab] = useState('Posts');
  const [list, setList] = useState<'followers' | 'following' | null>(null);
  const [editing, setEditing] = useState(search.get('edit') === '1');
  const coverInput = useRef<HTMLInputElement>(null);
  const [coverBusy, setCoverBusy] = useState(false);
  const p = prof.data;
  const content = useAsync(async () => {
    if (!p) return null;
    if (tab === 'Gifts') return { gifts: (await api.giftWall(p.id)).gifts };
    const r = await api.userPosts(p.id, tab.toLowerCase());
    if (r.posts) upsertPosts(r.posts);
    return r;
  }, [p?.id, tab]);

  if (prof.error) return <ErrorBox message={prof.error} onRetry={prof.reload} />;
  if (!p) return <><Skeleton h={300} /><Skeleton h={120} /></>;

  const message = async () => {
    try { const c = await api.startConversation(p.id); router.push('/messages?c=' + c.id); }
    catch (e) { showToast((e as Error).message); }
  };
  const giftCreator = async () => {
    const latest = (await api.userPosts(p.id).catch(() => ({ posts: [] }))).posts?.[0];
    openGift({ post: latest, user: { ...p, followers: p.stats.followers } });
  };
  const saveCover = async (coverImage: string | null) => {
    await api.updateMe({ coverImage });
    prof.setData({ ...p, coverImage });
  };
  const uploadCover = async (fl: FileList | null) => {
    const file = fl?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) return showToast('Choose an image file (JPG, PNG, WEBP or GIF).');
    setCoverBusy(true);
    try {
      await saveCover(await api.uploadProfileImage(file));
      showToast('Cover image updated');
    } catch (e) { showToast((e as Error).message); }
    finally { setCoverBusy(false); }
  };
  const removeCover = async () => {
    setCoverBusy(true);
    try { await saveCover(null); showToast('Cover image removed'); }
    catch (e) { showToast((e as Error).message); }
    finally { setCoverBusy(false); }
  };
  const joined = new Date(p.createdAt).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  const stats = [
    { value: compact(p.stats.posts), label: 'Posts' },
    { value: compact(p.stats.followers), label: 'Followers', go: () => setList('followers') },
    { value: compact(p.stats.following), label: 'Following', go: () => setList('following') },
    { value: p.stats.giftsReceived.toLocaleString(), label: 'Gifts received' },
  ];

  return (
    <div>
      <div style={s('background:#fff;border:1px solid rgba(16,20,16,.08);border-radius:22px;overflow:hidden')}>
        <div style={{ ...s('position:relative;height:150px;display:flex;align-items:center;justify-content:center'), background: p.coverImage ? `center / cover no-repeat url("${mediaUrl(p.coverImage)}")` : 'repeating-linear-gradient(115deg,#E8F5EE 0 14px,#DCEFE5 14px 28px)' }}>
          {!p.coverImage && !p.isMe && <span style={s('font-family:ui-monospace,Menlo,monospace;font-size:11px;letter-spacing:.06em;color:#6B7268;background:rgba(255,255,255,.85);padding:6px 11px;border-radius:99px')}>cover image</span>}
          {p.isMe && (
            <>
              <input ref={coverInput} type="file" accept="image/jpeg,image/png,image/webp,image/gif" hidden onChange={e => { uploadCover(e.target.files); e.target.value = ''; }} />
              {!p.coverImage && (
                <button onClick={() => coverInput.current?.click()} disabled={coverBusy} style={s('display:flex;align-items:center;gap:8px;font-size:12.5px;font-weight:700;color:#0E7546;background:rgba(255,255,255,.9);border:1px solid rgba(16,20,16,.08);padding:8px 14px;border-radius:99px')}>
                  {coverBusy ? <Spinner size={13} /> : <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="16" rx="3" /><path d="m4 17 5-5 4 4 3-2.5 4 3.5" /></svg>}
                  Add cover image
                </button>
              )}
              {p.coverImage && (
                <div style={s('position:absolute;top:12px;right:12px;display:flex;gap:6px')}>
                  <button onClick={() => coverInput.current?.click()} disabled={coverBusy} style={s('display:flex;align-items:center;gap:7px;font-size:12.5px;font-weight:700;color:#fff;background:rgba(16,20,16,.62);backdrop-filter:blur(6px);padding:7px 12px;border-radius:99px')}>
                    {coverBusy && <Spinner size={12} color="#fff" />}Change cover
                  </button>
                  <button onClick={removeCover} disabled={coverBusy} aria-label="Remove cover image" style={s('font-size:12.5px;font-weight:700;color:#fff;background:rgba(16,20,16,.62);backdrop-filter:blur(6px);padding:7px 12px;border-radius:99px')}>Remove</button>
                </div>
              )}
            </>
          )}
        </div>
        <div style={s('padding:0 20px 20px')}>
          <div style={s('position:relative;z-index:2;display:flex;align-items:flex-end;gap:14px;margin-top:-38px;flex-wrap:wrap')}>
            <Avatar user={p} size={88} style={{ border: '4px solid #fff', fontSize: 28, fontWeight: 800, background: p.avatar ? '#fff' : p.avatarColor, boxShadow: '0 2px 10px rgba(16,20,16,.12)' }} />
            <div style={s('display:flex;gap:8px;margin-left:auto;padding-bottom:6px;flex-wrap:wrap')}>
              {!p.isMe && (
                <button onClick={giftCreator} className={H.goldSoft} style={s('display:flex;align-items:center;gap:7px;font-size:13.5px;font-weight:700;color:#8A5E08;background:#FCF3E0;border:1px solid rgba(201,138,18,.3);padding:10px 16px;border-radius:99px')}>
                  <GiftIcon size={15} full={false} />Gift
                </button>
              )}
              {!p.isMe && <button onClick={message} className={H.ghost} style={s('font-size:13.5px;font-weight:700;border:1px solid rgba(16,20,16,.14);padding:10px 16px;border-radius:99px')}>Message</button>}
              {!p.isMe && <FollowButton key={p.id} userId={p.id} initial={p.isFollowing} onChange={(_, followers) => prof.setData({ ...p, isFollowing: _, stats: { ...p.stats, followers } })} />}
              {p.isMe && <button onClick={() => setEditing(true)} className={H.ghost} style={s('font-size:13.5px;font-weight:700;border:1px solid rgba(16,20,16,.14);padding:10px 16px;border-radius:99px')}>Edit profile</button>}
              {p.isMe && <Link href="/wallet?tab=Earnings" style={s('display:flex;align-items:center;gap:7px;font-size:13.5px;font-weight:700;color:#8A5E08;background:#FCF3E0;border:1px solid rgba(201,138,18,.3);padding:10px 16px;border-radius:99px')}><GiftIcon size={15} full={false} />Earnings</Link>}
            </div>
          </div>
          <div style={s('margin-top:12px')}>
            <div style={s('display:flex;align-items:center;gap:7px')}><span style={s('font-size:21px;font-weight:800;letter-spacing:-.02em')}>{p.displayName}</span>{p.verified && <Verified size={17} />}</div>
            <div style={s('font-size:14px;color:#6B7268;margin-top:2px')}>@{p.username}{p.followsYou && <span style={s('margin-left:8px;font-size:11.5px;font-weight:700;background:#EEF2EC;color:#5A6358;padding:2px 8px;border-radius:6px')}>Follows you</span>}</div>
            {p.bio && <p style={s('margin:11px 0 0;font-size:14.5px;line-height:1.6;max-width:56ch;text-wrap:pretty;white-space:pre-wrap')}>{p.bio}</p>}
            <div style={s('display:flex;gap:16px;flex-wrap:wrap;margin-top:11px;font-size:13.5px;color:#6B7268;font-weight:500')}>
              {p.location && <span>{p.location}</span>}
              {p.website && <a href={p.website.startsWith('http') ? p.website : 'https://' + p.website} target="_blank" rel="noreferrer">{p.website}</a>}
              <span>Joined {joined}</span>
            </div>
            <div style={s('display:flex;gap:20px;flex-wrap:wrap;margin-top:14px')}>
              {stats.map(st => (
                <button key={st.label} onClick={st.go} disabled={!st.go} style={{ cursor: st.go ? 'pointer' : 'default' }}>
                  <span style={s('font-size:16px;font-weight:800;font-variant-numeric:tabular-nums')}>{st.value}</span> <span style={s('font-size:13.5px;color:#6B7268;font-weight:500')}>{st.label}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      <Tabs items={['Posts', 'Replies', 'Media', 'Gifts']} value={tab} onChange={setTab} style={{ margin: '14px 0' }} />

      {content.error && <ErrorBox message={content.error} onRetry={content.reload} />}
      {content.loading && !content.data && <Skeleton h={140} />}
      {content.data && tab === 'Gifts' && 'gifts' in content.data && (
        <div style={s('background:#fff;border:1px solid rgba(16,20,16,.08);border-radius:20px;padding:18px')}>
          <h2 style={s('margin:0 0 3px;font-size:16px;font-weight:800')}>Gifts received</h2>
          <p style={s('margin:0 0 14px;font-size:13.5px;color:#6B7268')}>{p.isMe ? 'Public supporter wall. Only you can see the amounts.' : 'Public supporter wall. Amounts stay private.'}</p>
          {Boolean('hidden' in content.data && content.data.hidden) && <div style={s('font-size:13.5px;color:#6B7268')}>This creator keeps their supporter wall private.</div>}
          {!('hidden' in content.data && content.data.hidden) && content.data.gifts!.length === 0 && <div style={s('font-size:13.5px;color:#6B7268')}>No gifts yet. Be the first supporter.</div>}
          {content.data.gifts!.map(g => (
            <div key={g.id} style={s('display:flex;align-items:center;gap:12px;padding:11px 0;border-top:1px solid rgba(16,20,16,.06)')}>
              <Avatar user={g.sender} size={38} onClick={() => router.push('/profile/' + g.sender.username)} />
              <div style={s('flex:1;min-width:0')}><div style={s('font-size:14px;font-weight:700')}>{g.sender.displayName}</div><div style={s('font-size:12.5px;color:#6B7268;overflow:hidden;text-overflow:ellipsis;white-space:nowrap')}>{g.note} · {timeAgo(g.createdAt)}</div></div>
              <span style={s('font-size:12px;font-weight:700;color:#8A5E08;background:#FCF3E0;padding:5px 11px;border-radius:99px')}>{g.tier}</span>
            </div>
          ))}
        </div>
      )}
      {content.data && tab === 'Replies' && 'replies' in content.data && (
        <div style={s('display:flex;flex-direction:column;gap:12px')}>
          {content.data.replies!.length === 0 && <Empty title="No replies yet" />}
          {content.data.replies!.map(r => (
            <Link key={r.id} href={'/post/' + r.post.id} style={s('background:#fff;border:1px solid rgba(16,20,16,.08);border-radius:20px;padding:16px 18px;color:#101410;display:block')}>
              <div style={s('font-size:12.5px;color:#6B7268')}>Replying to @{r.post.username} · {timeAgo(r.createdAt)}</div>
              <p style={s('margin:8px 0 0;font-size:15px;line-height:1.55')}>{r.text}</p>
              <div style={s('margin-top:8px;font-size:12.5px;color:#9AA197;overflow:hidden;text-overflow:ellipsis;white-space:nowrap')}>“{r.post.text}”</div>
            </Link>
          ))}
        </div>
      )}
      {content.data && (tab === 'Posts' || tab === 'Media') && 'posts' in content.data && (
        <div style={s('display:flex;flex-direction:column;gap:12px')}>
          {content.data.posts!.length === 0 && <Empty title={tab === 'Media' ? 'No media yet' : 'No posts yet'} body={p.isMe ? 'Share your first post from the composer.' : undefined} />}
          {content.data.posts!.map(x => store[x.id]).filter(Boolean).map(x => <PostCard key={x.id} post={x} onDeleted={() => content.reload()} />)}
        </div>
      )}

      {list && <FollowList userId={p.id} kind={list} onClose={() => setList(null)} />}
      {editing && p.isMe && <EditProfile profile={p} onClose={() => { setEditing(false); router.replace('/profile/' + p.username); }} onSaved={prof.reload} />}
    </div>
  );
}

function FollowList({ userId, kind, onClose }: { userId: string; kind: 'followers' | 'following'; onClose: () => void }) {
  const { isMobile } = useViewport();
  const router = useRouter();
  const l = useAsync(() => (kind === 'followers' ? api.followers(userId) : api.following(userId)), [userId, kind]);
  return (
    <Modal onClose={onClose} isMobile={isMobile} label={kind} width={440}>
      <div style={s('display:flex;align-items:center;justify-content:space-between')}><h2 style={s('margin:0;font-size:18px;font-weight:800;text-transform:capitalize')}>{kind}</h2><CloseBtn onClick={onClose} /></div>
      <div style={{ marginTop: 10 }}>
        {l.loading && <div style={s('padding:20px;text-align:center;color:#14975C')}><Spinner /></div>}
        {l.data?.users.length === 0 && <div style={s('padding:20px 0;font-size:13.5px;color:#6B7268')}>Nobody here yet.</div>}
        {l.data?.users.map((u: PublicUser) => (
          <div key={u.id} style={s('display:flex;align-items:center;gap:11px;padding:10px 0;border-top:1px solid rgba(16,20,16,.06)')}>
            <Avatar user={u} size={40} onClick={() => { onClose(); router.push('/profile/' + u.username); }} />
            <div style={s('flex:1;min-width:0')}><div style={s('font-size:14px;font-weight:700')}>{u.displayName}</div><div style={s('font-size:12.5px;color:#6B7268')}>@{u.username}</div></div>
            {!u.isMe && <FollowButton userId={u.id} initial={!!u.isFollowing} small />}
          </div>
        ))}
      </div>
    </Modal>
  );
}

function EditProfile({ profile, onClose, onSaved }: { profile: Profile; onClose: () => void; onSaved: () => void }) {
  const { isMobile } = useViewport();
  const { setMe, showToast } = useApp();
  const [f, setF] = useState({ displayName: profile.displayName, bio: profile.bio ?? '', location: profile.location ?? '', website: profile.website ?? '', avatar: profile.avatar, coverImage: profile.coverImage });
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState<'avatar' | 'coverImage' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const coverFile = useRef<HTMLInputElement>(null);
  useEffect(() => setErr(null), [f]);
  const upload = async (fl: FileList | null, field: 'avatar' | 'coverImage') => {
    if (!fl?.[0]) return;
    if (!fl[0].type.startsWith('image/')) return setErr('Choose an image file.');
    setUploading(field);
    try { const url = await api.uploadProfileImage(fl[0]); setF(x => ({ ...x, [field]: url })); } catch (e) { setErr((e as Error).message); }
    finally { setUploading(null); }
  };
  const save = async () => {
    setBusy(true);
    try {
      const r = await api.updateMe({ displayName: f.displayName, bio: f.bio || null, location: f.location || null, website: f.website || null, avatar: f.avatar, coverImage: f.coverImage });
      setMe(r.user); onSaved(); showToast('Profile updated'); onClose();
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };
  const input = s('margin-top:6px;width:100%;border:1px solid rgba(16,20,16,.12);border-radius:13px;padding:12px 14px;outline:none;font-size:14.5px;font-weight:600');
  const lab = s('display:block;margin-top:12px;font-size:12.5px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:#6B7268');
  return (
    <Modal onClose={onClose} isMobile={isMobile} label="Edit profile">
      <div style={s('display:flex;align-items:center;justify-content:space-between')}><h2 style={s('margin:0;font-size:19px;font-weight:800')}>Edit profile</h2><CloseBtn onClick={onClose} /></div>
      <div style={s('margin-top:16px;font-size:12.5px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:#6B7268')}>Cover image</div>
      <div style={{ ...s('position:relative;margin-top:6px;height:110px;border-radius:14px;border:1px solid rgba(16,20,16,.08);display:flex;align-items:center;justify-content:center;gap:8px'), background: f.coverImage ? `center / cover no-repeat url("${mediaUrl(f.coverImage)}")` : 'repeating-linear-gradient(115deg,#E8F5EE 0 14px,#DCEFE5 14px 28px)' }}>
        <button onClick={() => coverFile.current?.click()} disabled={!!uploading} style={s('display:flex;align-items:center;gap:7px;font-size:12.5px;font-weight:700;color:#0E7546;background:rgba(255,255,255,.92);border:1px solid rgba(16,20,16,.08);padding:8px 14px;border-radius:99px')}>
          {uploading === 'coverImage' && <Spinner size={12} />}{f.coverImage ? 'Change cover' : 'Upload cover'}
        </button>
        {f.coverImage && <button onClick={() => setF(x => ({ ...x, coverImage: null }))} style={s('font-size:12.5px;font-weight:700;color:#A8331F;background:rgba(255,255,255,.92);padding:8px 14px;border-radius:99px')}>Remove</button>}
        <input ref={coverFile} type="file" accept="image/jpeg,image/png,image/webp,image/gif" hidden onChange={e => { upload(e.target.files, 'coverImage'); e.target.value = ''; }} />
      </div>
      <div style={s('display:flex;align-items:center;gap:14px;margin-top:14px')}>
        <Avatar user={{ ...profile, avatar: f.avatar }} size={64} />
        <button onClick={() => file.current?.click()} disabled={!!uploading} className={H.ghost} style={s('font-size:13px;font-weight:700;border:1px solid rgba(16,20,16,.14);padding:9px 14px;border-radius:99px;display:flex;gap:7px;align-items:center')}>{uploading === 'avatar' && <Spinner size={12} />}Upload photo</button>
        {f.avatar && <button onClick={() => setF(x => ({ ...x, avatar: null }))} style={s('font-size:13px;font-weight:700;color:#A8331F')}>Remove</button>}
        <input ref={file} type="file" accept="image/jpeg,image/png,image/webp,image/gif" hidden onChange={e => { upload(e.target.files, 'avatar'); e.target.value = ''; }} />
      </div>
      <label style={lab}>Name<input style={input} value={f.displayName} maxLength={50} onChange={e => setF({ ...f, displayName: e.target.value })} /></label>
      <label style={lab}>Bio<textarea style={{ ...input, resize: 'none' }} rows={3} maxLength={280} value={f.bio} onChange={e => setF({ ...f, bio: e.target.value })} /></label>
      <label style={lab}>Location<input style={input} value={f.location} maxLength={60} onChange={e => setF({ ...f, location: e.target.value })} /></label>
      <label style={lab}>Website<input style={input} value={f.website} maxLength={100} onChange={e => setF({ ...f, website: e.target.value })} /></label>
      {err && <div role="alert" style={s('margin-top:12px;font-size:13px;font-weight:700;color:#A8331F')}>{err}</div>}
      <button onClick={save} disabled={busy || !f.displayName.trim()} className={H.green} style={s('margin-top:18px;width:100%;background:#14975C;color:#fff;font-weight:800;font-size:15px;padding:14px;border-radius:14px;display:flex;justify-content:center;gap:8px;align-items:center')}>{busy && <Spinner size={15} color="#fff" />}Save</button>
    </Modal>
  );
}
