-- ============================================================
-- 091_sea_foto_usuario.sql - SEA: foto do usuário
-- ============================================================
-- Só o administrador coloca ou remove a foto (Sistema > Usuários). A
-- imagem já chega reduzida pelo painel (256 px, JPEG); o limite de 1 MB
-- protege o banco de um envio fora do painel.
--
-- Idempotent: safe to run more than once. Mirrored in db/schema.sql.
-- ============================================================

ALTER TABLE users ADD COLUMN IF NOT EXISTS photo BYTEA;
ALTER TABLE users ADD COLUMN IF NOT EXISTS photo_mime VARCHAR(20);
ALTER TABLE users ADD COLUMN IF NOT EXISTS photo_updated_at TIMESTAMPTZ;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_photo_valid') THEN
        ALTER TABLE users ADD CONSTRAINT users_photo_valid CHECK (
            (photo IS NULL AND photo_mime IS NULL)
            OR (photo IS NOT NULL AND octet_length(photo) <= 1048576
                AND photo_mime IN ('image/jpeg', 'image/png', 'image/webp'))
        );
    END IF;
END $$;
