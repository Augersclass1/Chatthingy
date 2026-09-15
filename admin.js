// Chatthingy admin tools. The server-side RLS policies in supabase.sql are the real security boundary.
(function(){
  const wait=setInterval(async()=>{
    if(!window.db || !window.currentUser) return;
    clearInterval(wait);
    const {data:p,error}=await db.from('profiles').select('is_admin,is_banned,is_blocked').eq('id',currentUser.id).single();
    if(error) return;
    if(p.is_banned){ alert('Your account has been banned.'); await db.auth.signOut(); return; }
    if(!p.is_admin) return;
    addAdminUI();
  },250);

  function addAdminUI(){
    if(document.getElementById('adminNav')) return;
    const nav=document.querySelector('.sidebar');
    const button=document.createElement('button');
    button.id='adminNav'; button.className='nav'; button.textContent='🛡️ Admin panel'; button.dataset.view='admin';
    nav.insertBefore(button,document.querySelector('.sidebar-title'));
    button.onclick=showAdmin;

    const section=document.createElement('div');
    section.id='adminView'; section.className='view hidden';
    section.innerHTML=`
      <div class="page-heading"><div><h2>Admin panel</h2><p class="muted">Manage users, posts, messages, and inspect all conversations.</p></div></div>
      <div class="admin-tabs"><button class="primary" id="adminUsersTab">Users</button><button class="ghost" id="adminChatsTab">All chats</button></div>
      <div id="adminUsers"></div><div id="adminChats" class="hidden"></div>`;
    document.querySelector('.content').appendChild(section);
    document.getElementById('adminUsersTab').onclick=()=>{document.getElementById('adminUsers').classList.remove('hidden');document.getElementById('adminChats').classList.add('hidden');loadUsers()};
    document.getElementById('adminChatsTab').onclick=()=>{document.getElementById('adminUsers').classList.add('hidden');document.getElementById('adminChats').classList.remove('hidden');loadAllChats()};
    loadUsers();
  }

  function showAdmin(){
    document.querySelectorAll('.nav').forEach(b=>b.classList.toggle('active',b.id==='adminNav'));
    ['boardView','chatsView'].forEach(id=>document.getElementById(id).classList.add('hidden'));
    document.getElementById('adminView').classList.remove('hidden');
    loadUsers();
  }

  async function loadUsers(){
    const box=document.getElementById('adminUsers'); if(!box)return;
    box.innerHTML='<p class="muted">Loading users...</p>';
    const {data,error}=await db.from('profiles').select('id,username,display_name,is_admin,is_blocked,is_banned,created_at').order('created_at',{ascending:true});
    if(error){box.innerHTML='<p class="error">'+esc(error.message)+'</p>';return;}
    box.innerHTML=(data||[]).map(u=>`<div class="admin-card"><div><b>@${esc(u.username)}</b>${u.is_admin?' <span class="admin-badge">ADMIN</span>':''}<div class="muted">${esc(u.display_name||'')} · ${u.is_banned?'BANNED':u.is_blocked?'BLOCKED':'Active'}</div></div><div class="admin-actions">${u.id===currentUser.id?'<span class="muted">You</span>':`<button class="ghost" onclick="adminToggleBlock('${u.id}',${!u.is_blocked})">${u.is_blocked?'Unblock':'Block'}</button><button class="delete-btn" onclick="adminToggleBan('${u.id}',${!u.is_banned})">${u.is_banned?'Unban':'Ban'}</button>`}</div></div>`).join('')||'<div class="empty"><h3>No users</h3></div>';
  }

  async function setStatus(id,field,value){
    const {error}=await db.from('profiles').update({[field]:value}).eq('id',id).neq('id',currentUser.id);
    if(error)alert(error.message); else loadUsers();
  }
  window.adminToggleBlock=(id,value)=>setStatus(id,'is_blocked',value);
  window.adminToggleBan=(id,value)=>{if(value&&!confirm('Ban this account? They will be unable to use Chatthingy.'))return;setStatus(id,'is_banned',value)};

  async function loadAllChats(){
    const box=document.getElementById('adminChats'); if(!box)return;
    box.innerHTML='<p class="muted">Loading all chats...</p>';
    const {data,error}=await db.from('conversations').select('id,name,is_group,created_at').order('created_at',{ascending:false});
    if(error){box.innerHTML='<p class="error">'+esc(error.message)+'</p>';return;}
    const chats=[];
    for(const c of data||[]){
      const {data:members}=await db.from('conversation_members').select('user_id,profiles(username)').eq('conversation_id',c.id);
      chats.push({...c,members:members||[]});
    }
    box.innerHTML=chats.map(c=>`<div class="admin-chat"><button class="admin-chat-head" onclick="adminOpenChat('${c.id}')"><div><b>${esc(c.is_group?(c.name||'Group chat'):'Private chat')}</b><div class="muted">${c.members.map(m=>'@'+esc(m.profiles?.username||'user')).join(', ')}</div></div><span>View</span></button><div id="admin-chat-${c.id}" class="admin-chat-messages hidden"></div></div>`).join('')||'<div class="empty"><h3>No chats</h3></div>';
  }

  window.adminOpenChat=async id=>{
    const box=document.getElementById('admin-chat-'+id); if(!box)return;
    box.classList.toggle('hidden'); if(box.classList.contains('hidden'))return;
    box.innerHTML='<p class="muted">Loading messages...</p>';
    const {data,error}=await db.from('messages').select('id,body,created_at,user_id,profiles(username)').eq('conversation_id',id).order('created_at',{ascending:true}).limit(1000);
    if(error){box.innerHTML='<p class="error">'+esc(error.message)+'</p>';return;}
    box.innerHTML=(data||[]).map(m=>`<div class="admin-message"><div><b>@${esc(m.profiles?.username||'user')}</b> <span class="muted">${new Date(m.created_at).toLocaleString()}</span></div><div>${esc(m.body)}</div><button class="delete-btn" onclick="adminDeleteMessage('${m.id}','${id}')">Delete</button></div>`).join('')||'<p class="muted">No messages.</p>';
  };
  window.adminDeleteMessage=async(id,chatId)=>{if(!confirm('Delete this message?'))return;const{error}=await db.from('messages').delete().eq('id',id);if(error)alert(error.message);else adminOpenChat(chatId)};

  function esc(v){return String(v??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));}
})();
