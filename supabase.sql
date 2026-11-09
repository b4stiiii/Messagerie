begin;

create table public.en_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  pseudo text not null check (char_length(pseudo) between 2 and 30)
);
create function public.en_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.en_profiles(id, pseudo)
  values (new.id, case when char_length(trim(new.raw_user_meta_data->>'pseudo')) between 2 and 30
    then trim(new.raw_user_meta_data->>'pseudo') else 'Membre' end);
  return new;
end; $$;
create trigger en_on_signup after insert on auth.users for each row execute function public.en_new_user();
insert into public.en_profiles(id, pseudo)
select id, case when char_length(trim(raw_user_meta_data->>'pseudo')) between 2 and 30
then trim(raw_user_meta_data->>'pseudo') else 'Membre' end from auth.users;

create table public.en_messages (
  id bigint generated always as identity primary key,
  sender_id uuid not null references public.en_profiles(id),
  recipient_id uuid not null references public.en_profiles(id),
  content text not null check (char_length(trim(content)) between 1 and 2000),
  created_at timestamptz not null default now(),
  check (sender_id <> recipient_id)
);
create index en_message_sender on public.en_messages(sender_id, created_at);
create index en_message_recipient on public.en_messages(recipient_id, created_at);

create table public.en_listings (
  id uuid primary key default gen_random_uuid(),
  seller_id uuid not null references public.en_profiles(id),
  title text not null check (char_length(trim(title)) between 1 and 100),
  description text not null check (char_length(trim(description)) between 1 and 2000),
  category text not null check (category in ('Mobilier','Musique','Véhicules','Autres')),
  start_cents bigint not null check (start_cents between 1 and 100000000),
  current_cents bigint not null check (current_cents between 1 and 100000000),
  photo_paths text[] not null default '{}',
  ends_at timestamptz not null,
  status text not null default 'active' check (status in ('active','sold','ended')),
  winner_id uuid references public.en_profiles(id),
  sold_at timestamptz,
  created_at timestamptz not null default now(),
  check (current_cents >= start_cents),
  check (winner_id is null or winner_id <> seller_id),
  check (cardinality(photo_paths) <= 5)
);
create index en_listing_end on public.en_listings(status, ends_at);
create index en_listing_seller on public.en_listings(seller_id);

alter table public.en_profiles enable row level security;
alter table public.en_messages enable row level security;
alter table public.en_listings enable row level security;
create policy en_profile_read on public.en_profiles for select to authenticated using (true);
create policy en_message_read on public.en_messages for select to authenticated
  using (auth.uid() = sender_id or auth.uid() = recipient_id);
create policy en_message_send on public.en_messages for insert to authenticated
  with check (auth.uid() = sender_id);
create policy en_listing_read on public.en_listings for select to authenticated using (true);
revoke all on public.en_profiles, public.en_messages, public.en_listings from anon, authenticated;
grant select on public.en_profiles, public.en_listings to authenticated;
grant select, insert on public.en_messages to authenticated;
grant usage on sequence public.en_messages_id_seq to authenticated;
revoke insert on public.en_messages from authenticated;
grant insert (sender_id, recipient_id, content) on public.en_messages to authenticated;

create function public.en_create_listing(
  p_title text, p_description text, p_category text,
  p_start_cents bigint, p_hours integer, p_photos text[] default '{}'
) returns uuid language plpgsql security definer set search_path = '' as $$
declare new_id uuid;
begin
  if auth.uid() is null then raise exception 'Connexion requise.'; end if;
  if p_hours is null or p_hours < 1 or p_hours > 720 then raise exception 'Durée invalide.'; end if;
  if p_photos is null or cardinality(p_photos) > 5 then raise exception 'Photos invalides.'; end if;
  if exists (select 1 from unnest(p_photos) as photo(path)
    where path is null or split_part(path, '/', 1) <> auth.uid()::text
      or not exists (select 1 from storage.objects o where o.bucket_id = 'listing-photos' and o.name = path))
  then raise exception 'Photo absente ou non autorisée.'; end if;
  insert into public.en_listings(seller_id,title,description,category,start_cents,current_cents,photo_paths,ends_at)
  values (auth.uid(),trim(p_title),trim(p_description),p_category,p_start_cents,p_start_cents,p_photos,
    clock_timestamp() + make_interval(hours => p_hours)) returning id into new_id;
  return new_id;
end; $$;

create function public.en_place_bid(p_listing_id uuid, p_amount_cents bigint)
returns void language plpgsql security definer set search_path = '' as $$
declare annonce public.en_listings%rowtype;
begin
  if auth.uid() is null then raise exception 'Connexion requise.'; end if;
  select * into annonce from public.en_listings where id = p_listing_id for update;
  if not found then raise exception 'Annonce introuvable.'; end if;
  if annonce.status <> 'active' or annonce.ends_at <= clock_timestamp() then raise exception 'Cette enchère est terminée.'; end if;
  if annonce.seller_id = auth.uid() then raise exception 'Tu ne peux pas enchérir sur ton annonce.'; end if;
  if p_amount_cents is null or p_amount_cents <= annonce.current_cents or p_amount_cents > 100000000
    then raise exception 'Mise trop basse ou invalide. Actualise le prix.'; end if;
  update public.en_listings set current_cents = p_amount_cents, winner_id = auth.uid() where id = p_listing_id;
end; $$;

create function public.en_finalize_expired() returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Connexion requise.'; end if;
  update public.en_listings
  set status = case when winner_id is null then 'ended' else 'sold' end,
      sold_at = case when winner_id is null then null else ends_at end
  where status = 'active' and ends_at <= clock_timestamp();
end; $$;

create function public.en_monthly_sales() returns setof public.en_listings
language sql stable security invoker set search_path = '' as $$
  select * from public.en_listings
  where status = 'sold'
    and sold_at >= (date_trunc('month', now() at time zone 'UTC') at time zone 'UTC')
    and sold_at < ((date_trunc('month', now() at time zone 'UTC') + interval '1 month') at time zone 'UTC')
  order by current_cents desc, sold_at desc limit 20;
$$;
revoke all on function public.en_new_user() from public, anon, authenticated;
revoke all on function public.en_create_listing(text,text,text,bigint,integer,text[]) from public, anon;
revoke all on function public.en_place_bid(uuid,bigint) from public, anon;
revoke all on function public.en_finalize_expired() from public, anon;
revoke all on function public.en_monthly_sales() from public, anon;
grant execute on function public.en_create_listing(text,text,text,bigint,integer,text[]) to authenticated;
grant execute on function public.en_place_bid(uuid,bigint) to authenticated;
grant execute on function public.en_finalize_expired() to authenticated;
grant execute on function public.en_monthly_sales() to authenticated;

insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('listing-photos','listing-photos',false,5242880,array['image/jpeg','image/png','image/webp']);
create policy en_photo_read on storage.objects for select to authenticated
  using (bucket_id = 'listing-photos');
create policy en_photo_upload on storage.objects for insert to authenticated
  with check (bucket_id = 'listing-photos' and (storage.foldername(name))[1] = auth.uid()::text);
create policy en_photo_remove on storage.objects for delete to authenticated
  using (bucket_id = 'listing-photos' and (storage.foldername(name))[1] = auth.uid()::text);
commit;
