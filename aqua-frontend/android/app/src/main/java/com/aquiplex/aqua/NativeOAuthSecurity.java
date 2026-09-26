package com.aquiplex.aqua;

import java.security.MessageDigest;
import java.security.SecureRandom;

/** Pure security helpers for the native Google OAuth handoff. */
final class NativeOAuthSecurity {
    static final int NONCE_BYTES = 32;
    static final int NONCE_MAX_LENGTH = 64;
    static final int CODE_MAX_LENGTH = 512;
    static final long NONCE_MAX_AGE_MS = 5 * 60 * 1000L;
    static final long CLOCK_SKEW_TOLERANCE_MS = 60 * 1000L;

    private NativeOAuthSecurity() {}

    static String generateNonce() {
        byte[] bytes = new byte[NONCE_BYTES];
        new SecureRandom().nextBytes(bytes);
        char[] alphabet = "0123456789abcdef".toCharArray();
        char[] out = new char[bytes.length * 2];
        for (int i = 0; i < bytes.length; i++) {
            int value = bytes[i] & 0xff;
            out[i * 2] = alphabet[value >>> 4];
            out[i * 2 + 1] = alphabet[value & 0x0f];
        }
        return new String(out);
    }

    static boolean isValidReturn(
            String scheme,
            String host,
            String path,
            String code,
            String nonce,
            String expectedNonce,
            long nonceCreatedAtMs,
            long nowMs) {
        if (!"https".equalsIgnoreCase(scheme)) return false;
        if (!"aquiplex.com".equalsIgnoreCase(host)) return false;
        if (!"/auth/native/return".equals(path)) return false;
        if (!isValidCode(code) || !isValidNonce(nonce) || !isValidNonce(expectedNonce)) return false;
        if (!constantTimeEquals(nonce, expectedNonce)) return false;

        long age = nowMs - nonceCreatedAtMs;
        return age >= -CLOCK_SKEW_TOLERANCE_MS && age <= NONCE_MAX_AGE_MS;
    }

    static boolean isValidNonce(String nonce) {
        return nonce != null
                && nonce.length() >= 16
                && nonce.length() <= NONCE_MAX_LENGTH
                && nonce.matches("[A-Za-z0-9_-]+");
    }

    static boolean isValidCode(String code) {
        return code != null && !code.isEmpty() && code.length() <= CODE_MAX_LENGTH;
    }

    static boolean constantTimeEquals(String a, String b) {
        if (a == null || b == null) return false;
        return MessageDigest.isEqual(a.getBytes(java.nio.charset.StandardCharsets.UTF_8),
                b.getBytes(java.nio.charset.StandardCharsets.UTF_8));
    }
}
