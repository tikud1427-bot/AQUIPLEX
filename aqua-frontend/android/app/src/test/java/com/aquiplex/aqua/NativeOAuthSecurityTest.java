package com.aquiplex.aqua;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class NativeOAuthSecurityTest {
    @Test
    public void nonceHasHighEntropyUrlSafeShape() {
        String nonce = NativeOAuthSecurity.generateNonce();
        assertTrue(NativeOAuthSecurity.isValidNonce(nonce));
        assertTrue(nonce.matches("[A-Fa-f0-9]{64}"));
        assertNotEquals(nonce, NativeOAuthSecurity.generateNonce());
    }

    @Test
    public void callbackRequiresExactProductionAppLinkAndNonceBinding() {
        String nonce = NativeOAuthSecurity.generateNonce();
        long now = 1_000_000L;
        String code = "one-time-code";

        assertTrue(NativeOAuthSecurity.isValidReturn(
                "https", "aquiplex.com", "/auth/native/return", code,
                nonce, nonce, now - 10_000L, now));

        assertFalse(NativeOAuthSecurity.isValidReturn(
                "http", "aquiplex.com", "/auth/native/return", code,
                nonce, nonce, now - 10_000L, now));
        assertFalse(NativeOAuthSecurity.isValidReturn(
                "https", "evil.example", "/auth/native/return", code,
                nonce, nonce, now - 10_000L, now));
        assertFalse(NativeOAuthSecurity.isValidReturn(
                "https", "aquiplex.com", "/auth/native/other", code,
                nonce, nonce, now - 10_000L, now));
        assertFalse(NativeOAuthSecurity.isValidReturn(
                "https", "aquiplex.com", "/auth/native/return", code,
                "wrong", nonce, now - 10_000L, now));
    }

    @Test
    public void callbackExpiresAndAcceptsSmallClockSkew() {
        String nonce = NativeOAuthSecurity.generateNonce();
        String code = "one-time-code";
        long created = 5_000_000L;

        assertTrue(NativeOAuthSecurity.isValidReturn(
                "https", "aquiplex.com", "/auth/native/return", code,
                nonce, nonce, created, created + 5_000L));
        assertTrue(NativeOAuthSecurity.isValidReturn(
                "https", "aquiplex.com", "/auth/native/return", code,
                nonce, nonce, created, created - 30_000L));
        assertFalse(NativeOAuthSecurity.isValidReturn(
                "https", "aquiplex.com", "/auth/native/return", code,
                nonce, nonce, created, created + NativeOAuthSecurity.NONCE_MAX_AGE_MS + 1));
    }
}
