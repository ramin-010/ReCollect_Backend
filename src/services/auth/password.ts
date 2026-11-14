// bcrypt helpers. Mongoose hashed in a pre('save') hook; with Prisma every write that sets a
// password must call hashPassword() explicitly (the users service does it for you).
import bcrypt from 'bcryptjs';

/** Salt rounds: 10 as before. Tests may lower it with BCRYPT_SALT_ROUNDS (bcryptjs is slow). */
function saltRounds(): number {
    const fromEnv = Number(process.env.BCRYPT_SALT_ROUNDS);
    return Number.isInteger(fromEnv) && fromEnv >= 4 && fromEnv <= 15 ? fromEnv : 10;
}

export async function hashPassword(plain: string): Promise<string> {
    const salt = await bcrypt.genSalt(saltRounds());
    return bcrypt.hash(plain, salt);
}

/** Compare a plain password with a stored hash. A missing hash never matches (instead of throwing). */
export async function verifyPassword(plain: string, hash: string | null | undefined): Promise<boolean> {
    if (!hash) return false;
    return bcrypt.compare(plain, hash);
}
