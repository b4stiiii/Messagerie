document.addEventListener('submit', event => event.preventDefault());
const page = document.body.dataset.page;
const $ = (id) => document.getElementById(id);
let client, utilisateur, membres = [], annonces = [], partenaire;
let lectureEnCours = false;

function informer(texte, erreur = false) {
  $('etat').textContent = texte;
  $('etat').classList.toggle('erreur', erreur);
}
function element(tag, texte, classe) {
  const el = document.createElement(tag);
  if (texte !== undefined) el.textContent = texte;
  if (classe) el.className = classe;
  return el;
}
function lien(texte, url) {
  const el = element('a', texte, 'bouton');
  el.href = url;
  return el;
}
function nom(id) { return membres.find(m => m.id === id)?.pseudo || 'Membre'; }
function euros(centimes) {
  return (centimes / 100).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' });
}
async function requete(action) {
  const { data, error } = await action;
  if (error) throw error;
  return data;
}
function brancher(formulaire, action) {
  formulaire.addEventListener('submit', async (event) => {
    event.preventDefault();
    const bouton = formulaire.querySelector('button');
    bouton.disabled = true;
    informer('En cours…');
    try { await action(new FormData(formulaire)); }
    catch (err) { informer(err.message || 'Impossible de terminer cette action.', true); }
    finally { bouton.disabled = false; }
  });
}
function naviguerConnecte(connecte) {
  document.querySelectorAll('[data-prive]').forEach(a => {
    if (connecte) a.removeAttribute('aria-disabled');
    else a.setAttribute('aria-disabled', 'true');
    a.addEventListener('click', event => {
      if (!utilisateur) {
        event.preventDefault();
        if (page === 'index') informer('Crée un compte ou connecte-toi pour continuer.');
        else location.replace('index.html');
      }
    });
  });
  $('deconnexion').hidden = !connecte;
}
function compte() {
  $('compte').hidden = !!utilisateur;
  $('connecte').hidden = !utilisateur;
  brancher($('inscription'), async (f) => {
    const pseudo = f.get('pseudo').trim();
    if (pseudo.length < 2) throw new Error('Le pseudo doit contenir au moins 2 caractères.');
    const data = await requete(client.auth.signUp({
      email: f.get('email').trim(), password: f.get('password'),
      options: { data: { pseudo }, emailRedirectTo: new URL('index.html', location.href).href }
    }));
    if (data.session) location.href = 'messagerie.html';
    else {
      informer('Demande envoyée. Consulte ton courriel pour confirmer le compte, puis connecte-toi.');
      $('inscription').reset();
    }
  });
  brancher($('connexion'), async (f) => {
    await requete(client.auth.signInWithPassword({ email: f.get('email').trim(), password: f.get('password') }));
    location.href = 'messagerie.html';
  });
}
function afficherContacts() {
  const conteneur = $('contacts');
  const recherche = $('recherche-contact').value.trim().toLowerCase();
  conteneur.replaceChildren();
  for (const membre of membres.filter(m => m.id !== utilisateur.id && m.pseudo.toLowerCase().includes(recherche))) {
    const carte = element('div', undefined, 'carte contact');
    carte.append(element('strong', `${membre.pseudo} · ${membre.id.slice(0, 6)}`), lien('Écrire', `conversations.html?avec=${membre.id}`));
    conteneur.append(carte);
  }
  if (!conteneur.children.length) conteneur.append(element('p', 'Aucun autre membre trouvé.'));
}
async function chargerConversations() {
  const donnees = await requete(client.from('en_messages').select('sender_id,recipient_id,created_at').order('created_at', { ascending: false }));
  const ids = [...new Set(donnees.map(m => m.sender_id === utilisateur.id ? m.recipient_id : m.sender_id))];
  if (partenaire && !ids.includes(partenaire)) ids.unshift(partenaire);
  $('conversations').replaceChildren();
  for (const id of ids) $('conversations').append(lien(`${nom(id)} · ${id.slice(0, 6)}`, `conversations.html?avec=${id}`));
  if (!ids.length) $('conversations').append(element('p', 'Aucun échange pour le moment.'));
}
async function chargerMessages() {
  if (!partenaire || lectureEnCours) return;
  lectureEnCours = true;
  try {
    const donnees = await requete(client.from('en_messages').select('*')
      .or(`sender_id.eq.${partenaire},recipient_id.eq.${partenaire}`)
      .order('created_at', { ascending: false }).limit(200));
    const zone = $('messages');
    const enBas = zone.scrollHeight - zone.scrollTop - zone.clientHeight < 50;
    const signature = JSON.stringify(donnees.map(m => m.id));
    if (zone.dataset.signature === signature) return;
    zone.dataset.signature = signature;
    zone.replaceChildren();
    for (const m of donnees.reverse()) {
      const bloc = element('div', undefined, `message${m.sender_id === utilisateur.id ? ' moi' : ''}`);
      bloc.append(element('p', m.content), element('small', new Date(m.created_at).toLocaleString('fr-FR')));
      zone.append(bloc);
    }
    if (!donnees.length) zone.append(element('p', 'Écris le premier message.'));
    if (enBas) zone.scrollTop = zone.scrollHeight;
  } finally { lectureEnCours = false; }
}
async function conversations() {
  partenaire = new URLSearchParams(location.search).get('avec');
  if (partenaire && (!membres.some(m => m.id === partenaire) || partenaire === utilisateur.id)) {
    throw new Error('Ce contact est introuvable. Choisis un membre dans Contacts.');
  }
  await chargerConversations();
  if (!partenaire) return;
  $('destinataire').textContent = `Avec ${nom(partenaire)} · ${partenaire.slice(0, 6)}`;
  $('envoi-message').hidden = false;
  brancher($('envoi-message'), async (f) => {
    const content = f.get('content').trim();
    if (!content) throw new Error('Écris un message avant de l’envoyer.');
    await requete(client.from('en_messages').insert({ sender_id: utilisateur.id, recipient_id: partenaire, content }));
    $('envoi-message').reset();
    await chargerMessages();
    $('messages').scrollTop = $('messages').scrollHeight;
    informer('Message envoyé.');
  });
  await chargerMessages();
  setInterval(() => {
    if (!document.hidden) chargerMessages().catch(() => informer('Actualisation impossible. Vérifie ta connexion.', true));
  }, 5000);
}
function creerAnnonce() {
  brancher($('creation'), async (f) => {
    const title = f.get('title').trim(), description = f.get('description').trim();
    const cents = Math.round(Number(f.get('price')) * 100);
    const hours = Number(f.get('hours'));
    if (!title || !description || !Number.isSafeInteger(cents) || cents < 1 || cents > 100000000 || !Number.isInteger(hours) || hours < 1 || hours > 720) {
      throw new Error('Vérifie le nom, la description, le prix et la durée (1 à 720 heures).');
    }
    const fichiers = [...$('photos').files];
    if (fichiers.length > 5 || fichiers.some(f => f.size > 5 * 1024 * 1024 || !['image/jpeg', 'image/png', 'image/webp'].includes(f.type))) {
      throw new Error('Choisis au maximum 5 photos JPEG, PNG ou WebP de 5 Mo chacune.');
    }
    const paths = [];
    try {
      for (const fichier of fichiers) {
        const extension = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[fichier.type];
        const chemin = `${utilisateur.id}/${crypto.randomUUID()}.${extension}`;
        await requete(client.storage.from('listing-photos').upload(chemin, fichier));
        paths.push(chemin);
      }
      await requete(client.rpc('en_create_listing', {
        p_title: title, p_description: description, p_category: f.get('category'),
        p_start_cents: cents, p_hours: hours, p_photos: paths
      }));
    } catch (err) {
      if (paths.length) await client.storage.from('listing-photos').remove(paths);
      throw err;
    }
    location.href = 'mes-annonces.html';
  });
}
function filtrerAnnonces() {
  const texte = $('recherche')?.value.trim().toLowerCase() || '';
  const categorie = $('filtre')?.value || '';
  const statut = $('statut')?.value || '';
  return annonces.filter(a => a.title.toLowerCase().includes(texte) && (!categorie || a.category === categorie) && (!statut || a.status === statut));
}
async function afficherAnnonces() {
  const zone = $('annonces');
  const cartes = [];
  let rang = 0;
  for (const annonce of filtrerAnnonces()) {
    const carte = element('article', undefined, 'carte');
    carte.append(element('h2', `${page === 'classement' ? `${++rang}. ` : ''}${annonce.title}`));
    if (annonce.photo_paths.length) {
      const galerie = element('div', undefined, 'photos');
      for (const chemin of annonce.photo_paths) {
        const { data, error } = await client.storage.from('listing-photos').createSignedUrl(chemin, 3600);
        if (!error && data) {
          const img = element('img');
          img.src = data.signedUrl; img.alt = `Photo de ${annonce.title}`; img.loading = 'lazy';
          img.width = 160; img.height = 130;
          galerie.append(img);
        }
      }
      carte.append(galerie);
    }
    carte.append(element('p', annonce.description), element('p', `Vendeur : ${nom(annonce.seller_id)} · ${annonce.category}`, 'petit'));
    const termine = annonce.status !== 'active' || new Date(annonce.ends_at) <= new Date();
    carte.append(element('p', `${annonce.status === 'sold' ? 'Prix final' : 'Prix actuel'} : ${euros(annonce.current_cents)}`, 'prix'));
    carte.append(element('p', `Fin : ${new Date(annonce.ends_at).toLocaleString('fr-FR')}`, 'petit'));
    carte.append(element('p', ({ active: 'En cours', sold: 'Vendue', ended: 'Terminée sans vente' })[annonce.status]));
    if (annonce.status === 'sold') carte.append(element('p', `Gagnant : ${nom(annonce.winner_id)}`));
    if (!termine && annonce.seller_id !== utilisateur.id) {
      const form = element('form');
      const id = `mise-${annonce.id}`;
      const label = element('label', 'Ta mise (€)'); label.htmlFor = id;
      const champ = element('input'); champ.type = 'number'; champ.name = 'amount'; champ.id = id;
      champ.step = '0.01'; champ.min = (annonce.current_cents + 1) / 100; champ.max = 1000000; champ.required = true;
      const bouton = element('button', 'Enchérir');
      form.append(label, champ, bouton);
      brancher(form, async f => {
        await requete(client.rpc('en_place_bid', { p_listing_id: annonce.id, p_amount_cents: Math.round(Number(f.get('amount')) * 100) }));
        await chargerAnnonces(); informer('Ta mise a été enregistrée.');
      });
      carte.append(form);
    }
    cartes.push(carte);
  }
  zone.replaceChildren(...cartes);
  if (!cartes.length) zone.append(element('p', page === 'classement' ? 'Aucune vente terminée ce mois-ci.' : 'Aucune annonce à afficher.'));
}
async function chargerAnnonces() {
  await requete(client.rpc('en_finalize_expired'));
  if (page === 'classement') annonces = await requete(client.rpc('en_monthly_sales'));
  else {
    let query = client.from('en_listings').select('*').order('created_at', { ascending: false });
    if (page === 'mes-annonces') query = query.eq('seller_id', utilisateur.id);
    else query = query.eq('status', 'active');
    annonces = await requete(query);
  }
  await afficherAnnonces();
}
async function demarrer() {
  naviguerConnecte(false);
  if (!window.CONFIG || CONFIG.url.includes('TON-PROJET') || CONFIG.key.includes('TA-CLE')) {
    if (page === 'index') $('contenu').hidden = false;
    throw new Error('Pour activer le site, renseigne l’URL et la clé publique Supabase dans config.js.');
  }
  if (!window.supabase) throw new Error('Supabase n’a pas pu être chargé. Vérifie ta connexion Internet.');
  client = window.supabase.createClient(CONFIG.url, CONFIG.key);
  const { data, error } = await client.auth.getUser();
  if (error && error.name !== 'AuthSessionMissingError') throw error;
  utilisateur = data?.user;
  if (!utilisateur && page !== 'index') { location.replace('index.html?connexion=requise'); return; }
  naviguerConnecte(!!utilisateur);
  client.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') {
      utilisateur = null;
      $('contenu').hidden = true;
      location.replace('index.html');
    }
  });
  $('deconnexion').addEventListener('click', async () => {
    try { await requete(client.auth.signOut()); location.replace('index.html'); }
    catch { informer('La déconnexion a échoué. Réessaie.', true); }
  });
  $('contenu').hidden = false;
  informer(new URLSearchParams(location.search).has('connexion') ? 'Connecte-toi pour accéder à cette page.' : '');
  if (page === 'index') { compte(); return; }
  membres = await requete(client.from('en_profiles').select('id,pseudo').order('pseudo'));
  if (page === 'contacts') {
    afficherContacts(); $('recherche-contact').addEventListener('input', afficherContacts);
  }
  if (page === 'conversations') await conversations();
  if (page === 'creer-annonce') creerAnnonce();
  if (['annonces', 'mes-annonces', 'classement'].includes(page)) {
    await chargerAnnonces();
    for (const id of ['recherche', 'filtre', 'statut']) {
      $(id)?.addEventListener('input', () => afficherAnnonces().catch(e => informer(e.message, true)));
    }
    $('actualiser')?.addEventListener('click', () => chargerAnnonces().then(() => informer('Liste actualisée.')).catch(e => informer(e.message, true)));
  }
}
demarrer().catch(err => informer(err.message || 'Chargement impossible.', true));
