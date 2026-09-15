// Chatthingy admin tools. The server-side RLS policies in supabase.sql are the real security boundary.
(function(){
  const wait=setInterval(async()=>{
    if(typeof db==='undefined' || typeof currentUser==='undefined' || !currentUser) return;
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
    document.querySelectorAll('.nav:not(#adminNav),#newChatButton,#newGroupButton').forEach(b=>b.addEventListener('click',()=>{const v=document.getElementById('adminView');if(v)v.classList.add('hidden')}));

    const section=document.createElement('div');
    section.id='adminView'; section.className='view hidden';
    section.innerHTML=`
      <div class="page-heading"><div><h2>Admin panel</h2><p class="muted">Manage users, public posts, messages, and inspect all conversations.</p></div></div>
      <div class="admin-tabs"><button class="primary" id="adminUsersTab">Users</button><button class="ghost" id="adminPostsTab">Posts</button><button class="ghost" id="adminChatsTab">All chats</button></div>
      <div id="adminUsers"></div><div id="adminPosts" class="hidden"></div><div id="adminChats" class="hidden"></div>`;
    document.querySelector('.content').appendChild(section);
    document.getElementById('adminUsersTab').onclick=()=>showAdminTab('adminUsers');
    document.getElementById('adminPostsTab').onclick=()=>showAdminTab('adminPosts');
    document.getElementById('adminChatsTab').onclick=()=>showAdminTab('adminChats');
    loadUsers();
  }

  function showAdmin(){
    document.querySelectorAll('.nav').forEach(b=>b.classList.toggle('active',b.id==='adminNav'));
    ['boardView','chatsView'].forEach(id=>document.getElementById(id).classList.add('hidden'));
    document.getElementById('adminView').classList.remove('hidden');
    showAdminTab('adminUsers');
  }
  function showAdminTab(id){
    ['adminUsers','adminPosts','adminChats'].forEach(x=>document.getElementById(x).classList.toggle('hidden',x!==id));
    if(id==='adminUsers')loadUsers();
    if(id==='adminPosts')loadPosts();
    if(id==='adminChats')loadAllChats();
  }

  async function loadUsers(){
    const box=document.getElementById('adminUsers'); if(!box)return;
    box.innerHTML='<p class="muted">Loading users...</p>';
    const {data,error}=await db.from('profiles').select('id,username,display_name,is_admin,is_blocked,is_banned,created_at').order('created_at',{ascending:true});
    if(error){box.innerHTML='<p class="error">'+esc(error.message)+'</p>';return;}
    box.innerHTML=(data||[]).map(u=>`<div class="admin-card"><div><b>@${esc(u.username)}</b>${u.is_admin?' <span class="admin-badge">ADMIN</span>':''}<div class="muted">${esc(u.display_name||'')} · ${u.is_banned?'BANNED':u.is_blocked?'BLOCKED':'Active'}</div></div><div class="admin-actions">${u.id===currentUser.id?'<span class="muted">You</span>':`<button class="ghost" onclick="adminToggleBlock('${u.id}',${!u.is_blocked})">${u.is_blocked?'Unblock':'Block'}</button><button class="delete-btn" onclick="adminToggleBan('${u.id}',${!u.is_banned})">${u.is_banned?'Unban':'Ban'}</button>`}</div></div>`).join('')||'<div class="empty"><h3>No users</h3></div>';
  }

  async function setStatus(id,blocked,banned){
    const {error}=await db.rpc('admin_set_user_status',{target_user_id:id,blocked,banned});
    if(error)alert(error.message); else loadUsers();
  }
  window.adminToggleBlock=async(id,value)=>{const {data,error}=await db.from('profiles').select('is_banned').eq('id',id).single();if(error){alert(error.message);return}setStatus(id,value,!!data.is_banned)};
  window.adminToggleBan=async(id,value)=>{if(value&&!confirm('Ban this account? They will be unable to use Chatthingy.'))return;const {data,error}=await db.from('profiles').select('is_blocked').eq('id',id).single();if(error){alert(error.message);return}setStatus(id,!!data.is_blocked,value)};

  async function loadPosts(){
    const box=document.getElementById('adminPosts'); if(!box)return;
    box.innerHTML='<p class="muted">Loading posts...</p>';
    const {data,error}=await db.from('posts').select('id,body,created_at,author:profiles!posts_author_id_fkey(username)').order('created_at',{ascending:false}).limit(200);
    if(error){box.innerHTML='<p class="error">'+esc(error.message)+'</p>';return;}
    box.innerHTML=(data||[]).map(p=>`<div class="admin-card"><div><b>@${esc(p.author?.username||'user')}</b><div>${esc(p.body)}</div><div class="muted">${new Date(p.created_at).toLocaleString()}</div></div><button class="delete-btn" onclick="adminDeletePost('${p.id}')">Delete</button></div>`).join('')||'<div class="empty"><h3>No posts</h3></div>';
  }
  window.adminDeletePost=async id=>{if(!confirm('Delete this post?'))return;const{error}=await db.from('posts').delete().eq('id',id);if(error)alert(error.message);else loadPosts()};

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
  window.adminDeleteMessage=async(id,chatId)=>{if(!confirm('Delete this message?'))return;const{error}=await db.from('messages').delete().eq('id',id);if(error)alert(error.message);else{const box=document.getElementById('admin-chat-'+chatId);box.classList.add('hidden');adminOpenChat(chatId)}};

  function esc(v){return String(v??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));}
})();
