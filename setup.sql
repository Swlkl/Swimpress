-- À coller dans Supabase > SQL Editor > Run
create table profiles (id uuid primary key references auth.users on delete cascade, pseudo text unique not null, role text not null default 'user');
create table requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  title text not null, file_name text not null, file_path text not null,
  status text not null default 'pending' check (status in ('pending','accepted','refused')),
  admin_note text, created_at timestamptz default now());

create function is_admin() returns boolean language sql security definer as
$$ select exists(select 1 from profiles where id = auth.uid() and role = 'admin') $$;

create function new_user() returns trigger language plpgsql security definer as
$$ begin insert into profiles(id, pseudo) values (new.id, new.raw_user_meta_data->>'pseudo'); return new; end $$;
create trigger on_signup after insert on auth.users for each row execute function new_user();

alter table profiles enable row level security;
alter table requests enable row level security;
create policy "profils lisibles" on profiles for select using (auth.uid() = id or is_admin());
create policy "voir" on requests for select using (user_id = auth.uid() or is_admin());
create policy "envoyer" on requests for insert with check (user_id = auth.uid() and status = 'pending');
create policy "décider" on requests for update using (is_admin());
create policy "supprimer" on requests for delete using (is_admin() or (user_id = auth.uid() and status = 'pending'));

insert into storage.buckets (id, name, public) values ('models', 'models', false);
create policy "upload" on storage.objects for insert with check (bucket_id='models' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "lire" on storage.objects for select using (bucket_id='models' and ((storage.foldername(name))[1] = auth.uid()::text or is_admin()));
create policy "effacer" on storage.objects for delete using (bucket_id='models' and ((storage.foldername(name))[1] = auth.uid()::text or is_admin()));

-- APRÈS t'être inscrit sur le site, remplace TONPSEUDO et lance :
-- update profiles set role = 'admin' where pseudo = 'TONPSEUDO';
