/*
 * The rest of the host's cryptography: Brotli, asymmetric keys (generate, inspect, RSA encrypt/decrypt, PSS), ECDH,
 * primes and X.509 inspection. `node:crypto`, `node:zlib` and `node:tls` are built on these in JavaScript
 * (quickjs/runtime/node-crypto2.js, native-modules.js).
 *
 * Keys cross the boundary as PEM strings or DER byte arrays and are parsed per call, like the existing pkSign: no
 * pointer ever reaches JavaScript. Errors carry the mbedTLS message and are given Node's codes by the caller.
 */

#define MBEDTLS_ALLOW_PRIVATE_ACCESS

#include "quickjs.h"

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <brotli/decode.h>
#include <brotli/encode.h>
#include <zstd.h>
#include <zstd_errors.h>

#include "mbedtls/bignum.h"
#include "mbedtls/cipher.h"
#include "mbedtls/nist_kw.h"
#include "mbedtls/ctr_drbg.h"
#include "mbedtls/ecdh.h"
#include "mbedtls/ecp.h"
#include "mbedtls/error.h"
#include "mbedtls/md.h"
#include "mbedtls/oid.h"
#include "mbedtls/pk.h"
#include "mbedtls/rsa.h"
#include "mbedtls/x509_crt.h"

extern mbedtls_ctr_drbg_context fg_drbg;
extern int fg_rng_init(void);
extern const char graak_ca_bundle[];

/* ------------------------------------------------------------------ helpers */

static JSValue fg_c_throw(JSContext *ctx, const char *code, const char *what, int mbed)
{
    char buf[160];
    char message[320];
    JSValue err = JS_NewError(ctx);
    if (mbed) {
        mbedtls_strerror(mbed, buf, sizeof(buf));
        snprintf(message, sizeof(message), "%s: %s", what, buf);
        JS_SetPropertyStr(ctx, err, "mbedtls", JS_NewInt32(ctx, mbed));
    } else {
        snprintf(message, sizeof(message), "%s", what);
    }
    JS_SetPropertyStr(ctx, err, "message", JS_NewString(ctx, message));
    JS_SetPropertyStr(ctx, err, "code", JS_NewString(ctx, code));
    return JS_Throw(ctx, err);
}

static mbedtls_md_type_t fg_c_md(const char *name)
{
    if (!strcmp(name, "sha1")) return MBEDTLS_MD_SHA1;
    if (!strcmp(name, "sha224")) return MBEDTLS_MD_SHA224;
    if (!strcmp(name, "sha256")) return MBEDTLS_MD_SHA256;
    if (!strcmp(name, "sha384")) return MBEDTLS_MD_SHA384;
    if (!strcmp(name, "sha512")) return MBEDTLS_MD_SHA512;
    if (!strcmp(name, "md5")) return MBEDTLS_MD_MD5;
    if (!strcmp(name, "sha3-224")) return MBEDTLS_MD_SHA3_224;
    if (!strcmp(name, "sha3-256")) return MBEDTLS_MD_SHA3_256;
    if (!strcmp(name, "sha3-384")) return MBEDTLS_MD_SHA3_384;
    if (!strcmp(name, "sha3-512")) return MBEDTLS_MD_SHA3_512;
    return MBEDTLS_MD_NONE;
}

/* Bytes of an argument that is a string (PEM: the terminating NUL is counted, as mbedTLS wants) or a Uint8Array
   (DER). The string form is freed by fg_c_release. */
typedef struct {
    const unsigned char *p;
    size_t len;
    const char *str;
    JSContext *ctx;
} fg_c_input;

static int fg_c_input_get(JSContext *ctx, JSValueConst v, fg_c_input *in)
{
    memset(in, 0, sizeof(*in));
    in->ctx = ctx;
    if (JS_IsString(v)) {
        size_t n = 0;
        in->str = JS_ToCStringLen(ctx, &n, v);
        if (!in->str) return -1;
        in->p = (const unsigned char *) in->str;
        in->len = n + 1;
        return 0;
    }
    {
        size_t n = 0;
        uint8_t *b = JS_GetUint8Array(ctx, &n, v);
        if (!b) return -1;
        in->p = b;
        in->len = n;
    }
    return 0;
}

static void fg_c_release(fg_c_input *in)
{
    if (in->str) JS_FreeCString(in->ctx, in->str);
}

/* A key of any kind: private, public, or the public key of a certificate. */
typedef struct {
    mbedtls_pk_context own;
    mbedtls_x509_crt crt;
    mbedtls_pk_context *pk;
    int is_private;
} fg_c_key;

static void fg_c_key_free(fg_c_key *k)
{
    mbedtls_pk_free(&k->own);
    mbedtls_x509_crt_free(&k->crt);
}

static int fg_c_key_load(fg_c_key *k, const unsigned char *p, size_t len, const char *pass, int want_private)
{
    int ret;
    memset(k, 0, sizeof(*k));
    mbedtls_pk_init(&k->own);
    mbedtls_x509_crt_init(&k->crt);
    fg_rng_init();
    ret = mbedtls_pk_parse_key(&k->own, p, len, (const unsigned char *) pass, pass ? strlen(pass) : 0,
                               mbedtls_ctr_drbg_random, &fg_drbg);
    if (ret == 0) {
        k->pk = &k->own;
        k->is_private = 1;
        return 0;
    }
    if (want_private) return ret;
    mbedtls_pk_free(&k->own);
    mbedtls_pk_init(&k->own);
    ret = mbedtls_pk_parse_public_key(&k->own, p, len);
    if (ret == 0) {
        k->pk = &k->own;
        return 0;
    }
    mbedtls_pk_free(&k->own);
    mbedtls_pk_init(&k->own);
    ret = mbedtls_x509_crt_parse(&k->crt, p, len);
    if (ret == 0) {
        k->pk = &k->crt.pk;
        return 0;
    }
    return ret;
}

static JSValue fg_c_bytes(JSContext *ctx, const unsigned char *p, size_t n)
{
    return JS_NewUint8ArrayCopy(ctx, p, n);
}

static JSValue fg_c_mpi(JSContext *ctx, const mbedtls_mpi *m)
{
    size_t n = mbedtls_mpi_size(m);
    unsigned char *buf = malloc(n ? n : 1);
    JSValue v;
    if (!buf) return JS_ThrowOutOfMemory(ctx);
    mbedtls_mpi_write_binary(m, buf, n);
    v = fg_c_bytes(ctx, buf, n);
    free(buf);
    return v;
}

/* ------------------------------------------------------------------ Brotli */

/* brotliCompress(bytes, quality, lgwin, mode) */
static JSValue fg_brotli_compress(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    size_t n = 0, cap, outlen;
    uint8_t *in = JS_GetUint8Array(ctx, &n, argv[0]);
    int32_t quality = 11, lgwin = 22, mode = 0;
    uint8_t *out;
    JSValue v;

    if (!in) return JS_EXCEPTION;
    if (argc > 1) JS_ToInt32(ctx, &quality, argv[1]);
    if (argc > 2) JS_ToInt32(ctx, &lgwin, argv[2]);
    if (argc > 3) JS_ToInt32(ctx, &mode, argv[3]);
    cap = BrotliEncoderMaxCompressedSize(n);
    if (cap == 0) cap = n + 1024;
    out = malloc(cap);
    if (!out) return JS_ThrowOutOfMemory(ctx);
    outlen = cap;
    if (!BrotliEncoderCompress(quality, lgwin, (BrotliEncoderMode) mode, n, in, &outlen, out)) {
        free(out);
        return fg_c_throw(ctx, "ERR_BROTLI_COMPRESSION_FAILED", "Compression failed", 0);
    }
    v = fg_c_bytes(ctx, out, outlen);
    free(out);
    return v;
}

/* brotliDecompress(bytes, maxOutputLength) */
static JSValue fg_brotli_decompress(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    size_t n = 0, cap, used = 0;
    uint8_t *in = JS_GetUint8Array(ctx, &n, argv[0]);
    double max_out = 0;
    BrotliDecoderState *st;
    BrotliDecoderResult r;
    const uint8_t *next_in;
    size_t avail_in;
    uint8_t *out;
    JSValue v;

    if (!in) return JS_EXCEPTION;
    if (argc > 1 && !JS_IsUndefined(argv[1])) JS_ToFloat64(ctx, &max_out, argv[1]);
    st = BrotliDecoderCreateInstance(NULL, NULL, NULL);
    if (!st) return JS_ThrowOutOfMemory(ctx);
    cap = n * 4 + 4096;
    out = malloc(cap);
    if (!out) {
        BrotliDecoderDestroyInstance(st);
        return JS_ThrowOutOfMemory(ctx);
    }
    next_in = in;
    avail_in = n;
    for (;;) {
        size_t avail_out = cap - used;
        uint8_t *next_out = out + used;
        r = BrotliDecoderDecompressStream(st, &avail_in, &next_in, &avail_out, &next_out, NULL);
        used = cap - avail_out;
        if (r == BROTLI_DECODER_RESULT_NEEDS_MORE_OUTPUT) {
            uint8_t *bigger;
            if (max_out > 0 && (double) used >= max_out) {
                free(out);
                BrotliDecoderDestroyInstance(st);
                return fg_c_throw(ctx, "ERR_BUFFER_TOO_LARGE", "Cannot create a Buffer larger than the maxOutputLength", 0);
            }
            cap *= 2;
            bigger = realloc(out, cap);
            if (!bigger) {
                free(out);
                BrotliDecoderDestroyInstance(st);
                return JS_ThrowOutOfMemory(ctx);
            }
            out = bigger;
            continue;
        }
        break;
    }
    if (r != BROTLI_DECODER_RESULT_SUCCESS) {
        BrotliDecoderErrorCode code = BrotliDecoderGetErrorCode(st);
        char name[96];
        JSValue err = JS_NewError(ctx);
        const char *what = r == BROTLI_DECODER_RESULT_NEEDS_MORE_INPUT ? "unexpected end of file" : "Decompression failed";
        snprintf(name, sizeof(name), "ERR_%s", BrotliDecoderErrorString(code));
        if (r == BROTLI_DECODER_RESULT_NEEDS_MORE_INPUT) snprintf(name, sizeof(name), "%s", "Z_BUF_ERROR");
        JS_SetPropertyStr(ctx, err, "message", JS_NewString(ctx, what));
        JS_SetPropertyStr(ctx, err, "code", JS_NewString(ctx, name));
        JS_SetPropertyStr(ctx, err, "errno", JS_NewInt32(ctx, r == BROTLI_DECODER_RESULT_NEEDS_MORE_INPUT ? -5 : (int) code));
        free(out);
        BrotliDecoderDestroyInstance(st);
        return JS_Throw(ctx, err);
    }
    BrotliDecoderDestroyInstance(st);
    v = fg_c_bytes(ctx, out, used);
    free(out);
    return v;
}

/* ------------------------------------------------------------------ X.509 */

static void fg_c_set_time(JSContext *ctx, JSValueConst obj, const char *name, const mbedtls_x509_time *t)
{
    char buf[40];
    snprintf(buf, sizeof(buf), "%04d-%02d-%02dT%02d:%02d:%02dZ", t->year, t->mon, t->day, t->hour, t->min, t->sec);
    JS_SetPropertyStr(ctx, obj, name, JS_NewString(ctx, buf));
}

static JSValue fg_c_dn(JSContext *ctx, const mbedtls_x509_name *name)
{
    JSValue arr = JS_NewArray(ctx);
    uint32_t i = 0;
    for (; name; name = name->next) {
        const char *short_name = NULL;
        char oidbuf[64];
        JSValue pair = JS_NewArray(ctx);
        if (mbedtls_oid_get_attr_short_name(&name->oid, &short_name) != 0 || !short_name) {
            if (mbedtls_oid_get_numeric_string(oidbuf, sizeof(oidbuf), &name->oid) < 0) oidbuf[0] = 0;
            short_name = oidbuf;
        }
        JS_SetPropertyUint32(ctx, pair, 0, JS_NewString(ctx, short_name));
        JS_SetPropertyUint32(ctx, pair, 1, JS_NewStringLen(ctx, (const char *) name->val.p, name->val.len));
        JS_SetPropertyUint32(ctx, arr, i++, pair);
    }
    return arr;
}

static const char *fg_c_curve_name(mbedtls_ecp_group_id id)
{
    const mbedtls_ecp_curve_info *info = mbedtls_ecp_curve_info_from_grp_id(id);
    return info ? info->name : "unknown";
}

static void fg_c_describe_pk(JSContext *ctx, JSValueConst obj, mbedtls_pk_context *pk)
{
    mbedtls_pk_type_t t = mbedtls_pk_get_type(pk);
    JS_SetPropertyStr(ctx, obj, "bits", JS_NewInt32(ctx, (int) mbedtls_pk_get_bitlen(pk)));
    if (t == MBEDTLS_PK_RSA || t == MBEDTLS_PK_RSASSA_PSS) {
        mbedtls_rsa_context *rsa = mbedtls_pk_rsa(*pk);
        mbedtls_mpi n, e;
        mbedtls_mpi_init(&n);
        mbedtls_mpi_init(&e);
        JS_SetPropertyStr(ctx, obj, "type", JS_NewString(ctx, t == MBEDTLS_PK_RSA ? "rsa" : "rsa-pss"));
        if (mbedtls_rsa_export(rsa, &n, NULL, NULL, NULL, &e) == 0) {
            JS_SetPropertyStr(ctx, obj, "modulus", fg_c_mpi(ctx, &n));
            JS_SetPropertyStr(ctx, obj, "exponent", fg_c_mpi(ctx, &e));
        }
        mbedtls_mpi_free(&n);
        mbedtls_mpi_free(&e);
    } else if (t == MBEDTLS_PK_ECKEY || t == MBEDTLS_PK_ECKEY_DH || t == MBEDTLS_PK_ECDSA) {
        mbedtls_ecp_keypair *ec = mbedtls_pk_ec(*pk);
        unsigned char pub[133];
        size_t plen = 0;
        JS_SetPropertyStr(ctx, obj, "type", JS_NewString(ctx, "ec"));
        JS_SetPropertyStr(ctx, obj, "curve", JS_NewString(ctx, fg_c_curve_name(ec->grp.id)));
        if (mbedtls_ecp_point_write_binary(&ec->grp, &ec->Q, MBEDTLS_ECP_PF_UNCOMPRESSED, &plen, pub, sizeof(pub)) == 0) {
            JS_SetPropertyStr(ctx, obj, "point", fg_c_bytes(ctx, pub, plen));
        }
    } else {
        JS_SetPropertyStr(ctx, obj, "type", JS_NewString(ctx, mbedtls_pk_get_name(pk)));
    }
}

/* x509Info(pemOrDer) -> the fields Node's certificate objects expose. */
static JSValue fg_x509_info(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    fg_c_input in;
    mbedtls_x509_crt crt;
    JSValue o, arr, ku;
    const mbedtls_x509_sequence *seq;
    uint32_t i;
    int ret;
    char buf[128];

    if (fg_c_input_get(ctx, argv[0], &in)) return JS_EXCEPTION;
    mbedtls_x509_crt_init(&crt);
    ret = mbedtls_x509_crt_parse(&crt, in.p, in.len);
    fg_c_release(&in);
    if (ret != 0) {
        mbedtls_x509_crt_free(&crt);
        return fg_c_throw(ctx, "ERR_OSSL_PEM_NO_START_LINE", "Certificate", ret);
    }
    o = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, o, "version", JS_NewInt32(ctx, crt.version));
    {
        char hex[2 * 32 + 1];
        size_t j, n = crt.serial.len > 32 ? 32 : crt.serial.len;
        for (j = 0; j < n; j++) snprintf(hex + 2 * j, 3, "%02X", crt.serial.p[j]);
        hex[2 * n] = 0;
        JS_SetPropertyStr(ctx, o, "serial", JS_NewString(ctx, hex));
    }
    JS_SetPropertyStr(ctx, o, "subject", fg_c_dn(ctx, &crt.subject));
    JS_SetPropertyStr(ctx, o, "issuer", fg_c_dn(ctx, &crt.issuer));
    fg_c_set_time(ctx, o, "validFrom", &crt.valid_from);
    fg_c_set_time(ctx, o, "validTo", &crt.valid_to);
    JS_SetPropertyStr(ctx, o, "raw", fg_c_bytes(ctx, crt.raw.p, crt.raw.len));
    JS_SetPropertyStr(ctx, o, "ca", JS_NewBool(ctx, crt.ext_types & MBEDTLS_X509_EXT_BASIC_CONSTRAINTS ? crt.ca_istrue : 0));
    if (mbedtls_oid_get_numeric_string(buf, sizeof(buf), &crt.sig_oid) > 0) {
        JS_SetPropertyStr(ctx, o, "signatureOid", JS_NewString(ctx, buf));
    }
    /* Subject alternative names: [[kind, value], ...] */
    arr = JS_NewArray(ctx);
    i = 0;
    for (seq = &crt.subject_alt_names; seq && seq->buf.p; seq = seq->next) {
        int tag = seq->buf.tag & MBEDTLS_ASN1_TAG_VALUE_MASK;
        JSValue pair = JS_NewArray(ctx);
        const char *kind = NULL;
        JSValue value = JS_UNDEFINED;
        if (tag == 2) kind = "DNS";
        else if (tag == 1) kind = "email";
        else if (tag == 6) kind = "URI";
        else if (tag == 7) kind = "IP Address";
        if (!kind) {
            JS_FreeValue(ctx, pair);
            continue;
        }
        if (tag == 7) {
            char ip[64];
            size_t j, pos = 0;
            if (seq->buf.len == 4) {
                snprintf(ip, sizeof(ip), "%u.%u.%u.%u", seq->buf.p[0], seq->buf.p[1], seq->buf.p[2], seq->buf.p[3]);
            } else {
                for (j = 0; j + 1 < seq->buf.len && pos + 6 < sizeof(ip); j += 2) {
                    pos += (size_t) snprintf(ip + pos, sizeof(ip) - pos, "%s%X", j ? ":" : "",
                                             (seq->buf.p[j] << 8) | seq->buf.p[j + 1]);
                }
                ip[pos] = 0;
            }
            value = JS_NewString(ctx, ip);
        } else {
            value = JS_NewStringLen(ctx, (const char *) seq->buf.p, seq->buf.len);
        }
        JS_SetPropertyUint32(ctx, pair, 0, JS_NewString(ctx, kind));
        JS_SetPropertyUint32(ctx, pair, 1, value);
        JS_SetPropertyUint32(ctx, arr, i++, pair);
    }
    JS_SetPropertyStr(ctx, o, "altNames", arr);
    /* Extended key usage as dotted OIDs. */
    ku = JS_NewArray(ctx);
    i = 0;
    for (seq = &crt.ext_key_usage; seq && seq->buf.p; seq = seq->next) {
        if (mbedtls_oid_get_numeric_string(buf, sizeof(buf), &seq->buf) > 0) {
            JS_SetPropertyUint32(ctx, ku, i++, JS_NewString(ctx, buf));
        }
    }
    JS_SetPropertyStr(ctx, o, "extKeyUsage", ku);
    fg_c_describe_pk(ctx, o, &crt.pk);
    {
        unsigned char spki[2048];
        int n = mbedtls_pk_write_pubkey_der(&crt.pk, spki, sizeof(spki));
        if (n > 0) JS_SetPropertyStr(ctx, o, "spki", fg_c_bytes(ctx, spki + sizeof(spki) - n, (size_t) n));
    }
    mbedtls_x509_crt_free(&crt);
    return o;
}

/* x509CheckIssued(certDer, issuerDer) -> whether issuer's key signed cert (time is ignored). */
static JSValue fg_x509_check_issued(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    fg_c_input a, b;
    mbedtls_x509_crt child, parent;
    int ret, ok;

    if (fg_c_input_get(ctx, argv[0], &a)) return JS_EXCEPTION;
    if (fg_c_input_get(ctx, argv[1], &b)) {
        fg_c_release(&a);
        return JS_EXCEPTION;
    }
    mbedtls_x509_crt_init(&child);
    mbedtls_x509_crt_init(&parent);
    ret = mbedtls_x509_crt_parse(&child, a.p, a.len);
    if (ret == 0) ret = mbedtls_x509_crt_parse(&parent, b.p, b.len);
    fg_c_release(&a);
    fg_c_release(&b);
    if (ret != 0) {
        mbedtls_x509_crt_free(&child);
        mbedtls_x509_crt_free(&parent);
        return fg_c_throw(ctx, "ERR_OSSL_PEM_NO_START_LINE", "Certificate", ret);
    }
    /* The issuer's name matches and its key made the signature; validity dates are not looked at. */
    ok = child.issuer_raw.len == parent.subject_raw.len && memcmp(child.issuer_raw.p, parent.subject_raw.p, parent.subject_raw.len) == 0;
    if (ok) {
        const mbedtls_md_info_t *info = mbedtls_md_info_from_type(child.sig_md);
        unsigned char hash[64];
        ok = info && mbedtls_md(info, child.tbs.p, child.tbs.len, hash) == 0 &&
             mbedtls_pk_verify_ext(child.sig_pk, child.sig_opts, &parent.pk, child.sig_md, hash, mbedtls_md_get_size(info),
                                   child.sig.p, child.sig.len) == 0;
    }
    mbedtls_x509_crt_free(&child);
    mbedtls_x509_crt_free(&parent);
    return JS_NewBool(ctx, ok);
}

/* keyMatchesCert(certPem, keyPem, passphrase) */
static JSValue fg_key_matches_cert(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    fg_c_input a, b;
    const char *pass = NULL;
    fg_c_key pub, priv;
    int ret, ok = 0;

    if (fg_c_input_get(ctx, argv[0], &a)) return JS_EXCEPTION;
    if (fg_c_input_get(ctx, argv[1], &b)) {
        fg_c_release(&a);
        return JS_EXCEPTION;
    }
    if (argc > 2 && JS_IsString(argv[2])) pass = JS_ToCString(ctx, argv[2]);
    ret = fg_c_key_load(&pub, a.p, a.len, NULL, 0);
    if (ret == 0) {
        ret = fg_c_key_load(&priv, b.p, b.len, pass, 1);
        if (ret == 0) {
            ok = mbedtls_pk_check_pair(pub.pk, priv.pk, mbedtls_ctr_drbg_random, &fg_drbg) == 0;
            fg_c_key_free(&priv);
        }
        fg_c_key_free(&pub);
    }
    fg_c_release(&a);
    fg_c_release(&b);
    if (pass) JS_FreeCString(ctx, pass);
    if (ret != 0) return fg_c_throw(ctx, "ERR_OSSL_UNSUPPORTED", "key", ret);
    return JS_NewBool(ctx, ok);
}

/* ------------------------------------------------------------------ keys */

/* keyInfo(pemOrDer, passphrase, wantPrivate) -> { private, type, bits, ..., spki, pkcs (private DER) } */
static JSValue fg_key_info(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    fg_c_input in;
    fg_c_key k;
    const char *pass = NULL;
    int want_private = argc > 2 && JS_ToBool(ctx, argv[2]);
    int ret;
    JSValue o;
    unsigned char der[8192];
    int n;

    if (fg_c_input_get(ctx, argv[0], &in)) return JS_EXCEPTION;
    if (argc > 1 && JS_IsString(argv[1])) pass = JS_ToCString(ctx, argv[1]);
    ret = fg_c_key_load(&k, in.p, in.len, pass, want_private);
    fg_c_release(&in);
    if (pass) JS_FreeCString(ctx, pass);
    if (ret != 0) {
        const char *code = ret == MBEDTLS_ERR_PK_PASSWORD_REQUIRED ? "ERR_MISSING_PASSPHRASE"
                           : ret == MBEDTLS_ERR_PK_PASSWORD_MISMATCH ? "ERR_OSSL_BAD_DECRYPT"
                                                                      : "ERR_OSSL_UNSUPPORTED";
        return fg_c_throw(ctx, code, "error:1E08010C:DECODER routines::unsupported", ret);
    }
    o = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, o, "private", JS_NewBool(ctx, k.is_private));
    fg_c_describe_pk(ctx, o, k.pk);
    n = mbedtls_pk_write_pubkey_der(k.pk, der, sizeof(der));
    if (n > 0) JS_SetPropertyStr(ctx, o, "spki", fg_c_bytes(ctx, der + sizeof(der) - n, (size_t) n));
    if (k.is_private) {
        n = mbedtls_pk_write_key_der(k.pk, der, sizeof(der));
        if (n > 0) JS_SetPropertyStr(ctx, o, "pkcs", fg_c_bytes(ctx, der + sizeof(der) - n, (size_t) n));
    }
    fg_c_key_free(&k);
    return o;
}

/* generateKey("rsa", bits, exponent) or ("ec", curveName) -> { pkcs (private DER: PKCS#1 / SEC1), spki } */
static int fg_c_curve_id(const char *name, mbedtls_ecp_group_id *id)
{
    static const struct { const char *alias; const char *canonical; } aliases[] = {
        {"prime256v1", "secp256r1"}, {"P-256", "secp256r1"}, {"P-384", "secp384r1"}, {"P-521", "secp521r1"},
        {"prime192v1", "secp192r1"}, {"X25519", "x25519"},   {"x25519", "x25519"},
    };
    const mbedtls_ecp_curve_info *info;
    size_t i;
    for (i = 0; i < sizeof(aliases) / sizeof(aliases[0]); i++) {
        if (!strcmp(name, aliases[i].alias)) {
            name = aliases[i].canonical;
            break;
        }
    }
    info = mbedtls_ecp_curve_info_from_name(name);
    if (!info) return -1;
    *id = info->grp_id;
    return 0;
}

static JSValue fg_generate_key(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    const char *kind = JS_ToCString(ctx, argv[0]);
    mbedtls_pk_context pk;
    unsigned char der[8192];
    int ret = 0, n;
    JSValue o;

    if (!kind) return JS_EXCEPTION;
    fg_rng_init();
    mbedtls_pk_init(&pk);
    if (!strcmp(kind, "rsa")) {
        int32_t bits = 2048, exponent = 65537;
        if (argc > 1) JS_ToInt32(ctx, &bits, argv[1]);
        if (argc > 2 && !JS_IsUndefined(argv[2])) JS_ToInt32(ctx, &exponent, argv[2]);
        ret = mbedtls_pk_setup(&pk, mbedtls_pk_info_from_type(MBEDTLS_PK_RSA));
        if (ret == 0) ret = mbedtls_rsa_gen_key(mbedtls_pk_rsa(pk), mbedtls_ctr_drbg_random, &fg_drbg, (unsigned) bits, exponent);
    } else if (!strcmp(kind, "ec")) {
        const char *curve = argc > 1 ? JS_ToCString(ctx, argv[1]) : NULL;
        mbedtls_ecp_group_id gid;
        if (!curve || fg_c_curve_id(curve, &gid) != 0 || gid == MBEDTLS_ECP_DP_CURVE25519 || gid == MBEDTLS_ECP_DP_CURVE448) {
            if (curve) JS_FreeCString(ctx, curve);
            JS_FreeCString(ctx, kind);
            mbedtls_pk_free(&pk);
            return fg_c_throw(ctx, "ERR_CRYPTO_INVALID_CURVE", "Invalid EC curve name", 0);
        }
        JS_FreeCString(ctx, curve);
        ret = mbedtls_pk_setup(&pk, mbedtls_pk_info_from_type(MBEDTLS_PK_ECKEY));
        if (ret == 0) ret = mbedtls_ecp_gen_key(gid, mbedtls_pk_ec(pk), mbedtls_ctr_drbg_random, &fg_drbg);
    } else {
        JS_FreeCString(ctx, kind);
        mbedtls_pk_free(&pk);
        return fg_c_throw(ctx, "ERR_INVALID_ARG_VALUE", "unsupported key type", 0);
    }
    JS_FreeCString(ctx, kind);
    if (ret != 0) {
        mbedtls_pk_free(&pk);
        return fg_c_throw(ctx, "ERR_CRYPTO_OPERATION_FAILED", "key generation", ret);
    }
    o = JS_NewObject(ctx);
    n = mbedtls_pk_write_key_der(&pk, der, sizeof(der));
    if (n > 0) JS_SetPropertyStr(ctx, o, "pkcs", fg_c_bytes(ctx, der + sizeof(der) - n, (size_t) n));
    n = mbedtls_pk_write_pubkey_der(&pk, der, sizeof(der));
    if (n > 0) JS_SetPropertyStr(ctx, o, "spki", fg_c_bytes(ctx, der + sizeof(der) - n, (size_t) n));
    mbedtls_pk_free(&pk);
    return o;
}

/* rsaCrypt(op, key, passphrase, data, padding, hash, label)
   op: 0 publicEncrypt, 1 privateDecrypt, 2 privateEncrypt, 3 publicDecrypt. padding: 1 PKCS#1 v1.5, 4 OAEP. */
static JSValue fg_rsa_crypt(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    int32_t op = 0, padding = 4;
    fg_c_input key;
    fg_c_key k;
    const char *pass = NULL, *hash = NULL;
    size_t dlen = 0, llen = 0, olen = 0;
    uint8_t *data;
    const unsigned char *label = NULL;
    unsigned char *out;
    mbedtls_rsa_context *rsa;
    int ret;
    JSValue v;

    JS_ToInt32(ctx, &op, argv[0]);
    if (fg_c_input_get(ctx, argv[1], &key)) return JS_EXCEPTION;
    if (JS_IsString(argv[2])) pass = JS_ToCString(ctx, argv[2]);
    data = JS_GetUint8Array(ctx, &dlen, argv[3]);
    if (argc > 4) JS_ToInt32(ctx, &padding, argv[4]);
    if (argc > 5 && JS_IsString(argv[5])) hash = JS_ToCString(ctx, argv[5]);
    if (argc > 6 && !JS_IsUndefined(argv[6]) && !JS_IsNull(argv[6])) label = JS_GetUint8Array(ctx, &llen, argv[6]);
    if (!data) {
        fg_c_release(&key);
        if (pass) JS_FreeCString(ctx, pass);
        if (hash) JS_FreeCString(ctx, hash);
        return JS_EXCEPTION;
    }
    ret = fg_c_key_load(&k, key.p, key.len, pass, op == 1 || op == 2);
    fg_c_release(&key);
    if (pass) JS_FreeCString(ctx, pass);
    if (ret != 0) {
        if (hash) JS_FreeCString(ctx, hash);
        return fg_c_throw(ctx, "ERR_OSSL_UNSUPPORTED", "key", ret);
    }
    if (mbedtls_pk_get_type(k.pk) != MBEDTLS_PK_RSA) {
        fg_c_key_free(&k);
        if (hash) JS_FreeCString(ctx, hash);
        return fg_c_throw(ctx, "ERR_OSSL_EVP_OPERATION_NOT_SUPPORTED_FOR_THIS_KEYTYPE", "not an RSA key", 0);
    }
    rsa = mbedtls_pk_rsa(*k.pk);
    {
        mbedtls_md_type_t md = hash ? fg_c_md(hash) : MBEDTLS_MD_SHA1;
        if (md == MBEDTLS_MD_NONE) md = MBEDTLS_MD_SHA1;
        if (padding == 4) {
            mbedtls_rsa_set_padding(rsa, MBEDTLS_RSA_PKCS_V21, md);
        } else {
            mbedtls_rsa_set_padding(rsa, MBEDTLS_RSA_PKCS_V15, MBEDTLS_MD_NONE);
        }
    }
    if (hash) JS_FreeCString(ctx, hash);
    olen = mbedtls_rsa_get_len(rsa);
    out = malloc(olen ? olen : 1);
    if (!out) {
        fg_c_key_free(&k);
        return JS_ThrowOutOfMemory(ctx);
    }
    if (op == 0) {
        ret = padding == 4 ? mbedtls_rsa_rsaes_oaep_encrypt(rsa, mbedtls_ctr_drbg_random, &fg_drbg, label, llen, dlen, data, out)
                           : mbedtls_rsa_rsaes_pkcs1_v15_encrypt(rsa, mbedtls_ctr_drbg_random, &fg_drbg, dlen, data, out);
    } else if (op == 1) {
        size_t got = 0;
        ret = padding == 4 ? mbedtls_rsa_rsaes_oaep_decrypt(rsa, mbedtls_ctr_drbg_random, &fg_drbg, label, llen, &got, data, out, olen)
                           : mbedtls_rsa_rsaes_pkcs1_v15_decrypt(rsa, mbedtls_ctr_drbg_random, &fg_drbg, &got, data, out, olen);
        if (ret == 0) olen = got;
    } else if (op == 2) {
        ret = mbedtls_rsa_pkcs1_sign(rsa, mbedtls_ctr_drbg_random, &fg_drbg, MBEDTLS_MD_NONE, dlen, data, out);
    } else {
        size_t got = 0;
        /* publicDecrypt: raw public operation, then strip the type 1 padding. */
        unsigned char *raw = malloc(olen);
        if (!raw || dlen != olen) {
            free(raw);
            ret = MBEDTLS_ERR_RSA_BAD_INPUT_DATA;
        } else {
            ret = mbedtls_rsa_public(rsa, data, raw);
            if (ret == 0) {
                size_t i = 2;
                if (raw[0] != 0 || raw[1] != 1) {
                    ret = MBEDTLS_ERR_RSA_INVALID_PADDING;
                } else {
                    while (i < olen && raw[i] == 0xff) i++;
                    if (i >= olen || raw[i] != 0) {
                        ret = MBEDTLS_ERR_RSA_INVALID_PADDING;
                    } else {
                        got = olen - i - 1;
                        memcpy(out, raw + i + 1, got);
                        olen = got;
                    }
                }
            }
            free(raw);
        }
    }
    fg_c_key_free(&k);
    if (ret != 0) {
        free(out);
        return fg_c_throw(ctx, op == 1 || op == 3 ? "ERR_OSSL_RSA_OAEP_DECODING_ERROR" : "ERR_OSSL_RSA_DATA_TOO_LARGE_FOR_KEY_SIZE",
                          op == 1 || op == 3 ? "error:02000079:rsa routines::oaep decoding error" : "RSA operation", ret);
    }
    v = fg_c_bytes(ctx, out, olen);
    free(out);
    return v;
}

/* pkSignEx(hash, key, passphrase, data, padding, saltLen): padding 0 PKCS#1 v1.5 / ECDSA (DER), 1 PSS. */
static JSValue fg_pk_sign_ex(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    const char *hash = JS_ToCString(ctx, argv[0]);
    const char *pass = NULL;
    fg_c_input key;
    fg_c_key k;
    size_t dlen = 0, siglen = 0;
    uint8_t *data;
    unsigned char digest[64], sig[MBEDTLS_PK_SIGNATURE_MAX_SIZE];
    int32_t padding = 0, salt = -1;
    mbedtls_md_type_t md;
    int ret;

    if (!hash) return JS_EXCEPTION;
    md = fg_c_md(hash);
    JS_FreeCString(ctx, hash);
    if (md == MBEDTLS_MD_NONE) return fg_c_throw(ctx, "ERR_OSSL_EVP_INVALID_DIGEST", "Invalid digest", 0);
    if (fg_c_input_get(ctx, argv[1], &key)) return JS_EXCEPTION;
    if (JS_IsString(argv[2])) pass = JS_ToCString(ctx, argv[2]);
    data = JS_GetUint8Array(ctx, &dlen, argv[3]);
    if (argc > 4) JS_ToInt32(ctx, &padding, argv[4]);
    if (argc > 5) JS_ToInt32(ctx, &salt, argv[5]);
    if (!data) {
        fg_c_release(&key);
        if (pass) JS_FreeCString(ctx, pass);
        return JS_EXCEPTION;
    }
    ret = fg_c_key_load(&k, key.p, key.len, pass, 1);
    fg_c_release(&key);
    if (pass) JS_FreeCString(ctx, pass);
    if (ret != 0) return fg_c_throw(ctx, "ERR_OSSL_UNSUPPORTED", "private key", ret);
    ret = mbedtls_md(mbedtls_md_info_from_type(md), data, dlen, digest);
    if (ret == 0) {
        size_t hlen = mbedtls_md_get_size(mbedtls_md_info_from_type(md));
        if (padding == 1 && mbedtls_pk_get_type(k.pk) == MBEDTLS_PK_RSA) {
            mbedtls_rsa_context *rsa = mbedtls_pk_rsa(*k.pk);
            size_t klen = mbedtls_rsa_get_len(rsa);
            int use_salt = salt;
            if (salt == -1) use_salt = (int) hlen;                 /* RSA_PSS_SALTLEN_DIGEST */
            else if (salt < 0) use_salt = (int) (klen - hlen - 2); /* RSA_PSS_SALTLEN_MAX_SIGN */
            mbedtls_rsa_set_padding(rsa, MBEDTLS_RSA_PKCS_V21, md);
            ret = mbedtls_rsa_rsassa_pss_sign_ext(rsa, mbedtls_ctr_drbg_random, &fg_drbg, md, (unsigned) hlen, digest,
                                                  use_salt, sig);
            siglen = klen;
        } else {
            ret = mbedtls_pk_sign(k.pk, md, digest, hlen, sig, sizeof(sig), &siglen, mbedtls_ctr_drbg_random, &fg_drbg);
        }
    }
    fg_c_key_free(&k);
    if (ret != 0) return fg_c_throw(ctx, "ERR_OSSL_RSA_DIGEST_TOO_BIG_FOR_RSA_KEY", "sign", ret);
    return fg_c_bytes(ctx, sig, siglen);
}

/* pkVerifyEx(hash, key, data, signature, padding, saltLen) */
static JSValue fg_pk_verify_ex(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    const char *hash = JS_ToCString(ctx, argv[0]);
    fg_c_input key;
    fg_c_key k;
    size_t dlen = 0, slen = 0;
    uint8_t *data, *sig;
    unsigned char digest[64];
    int32_t padding = 0, salt = -1;
    mbedtls_md_type_t md;
    int ret, ok = 0;

    if (!hash) return JS_EXCEPTION;
    md = fg_c_md(hash);
    JS_FreeCString(ctx, hash);
    if (md == MBEDTLS_MD_NONE) return fg_c_throw(ctx, "ERR_OSSL_EVP_INVALID_DIGEST", "Invalid digest", 0);
    if (fg_c_input_get(ctx, argv[1], &key)) return JS_EXCEPTION;
    data = JS_GetUint8Array(ctx, &dlen, argv[2]);
    sig = JS_GetUint8Array(ctx, &slen, argv[3]);
    if (argc > 4) JS_ToInt32(ctx, &padding, argv[4]);
    if (argc > 5) JS_ToInt32(ctx, &salt, argv[5]);
    if (!data || !sig) {
        fg_c_release(&key);
        return JS_EXCEPTION;
    }
    ret = fg_c_key_load(&k, key.p, key.len, NULL, 0);
    fg_c_release(&key);
    if (ret != 0) return fg_c_throw(ctx, "ERR_OSSL_UNSUPPORTED", "public key", ret);
    if (mbedtls_md(mbedtls_md_info_from_type(md), data, dlen, digest) == 0) {
        size_t hlen = mbedtls_md_get_size(mbedtls_md_info_from_type(md));
        if (padding == 1 && mbedtls_pk_get_type(k.pk) == MBEDTLS_PK_RSA) {
            mbedtls_rsa_context *rsa = mbedtls_pk_rsa(*k.pk);
            size_t klen = mbedtls_rsa_get_len(rsa);
            int use_salt = salt;
            if (salt == -1) use_salt = (int) hlen;
            else if (salt < 0) use_salt = MBEDTLS_RSA_SALT_LEN_ANY;
            (void) klen;
            mbedtls_rsa_set_padding(rsa, MBEDTLS_RSA_PKCS_V21, md);
            ok = mbedtls_rsa_rsassa_pss_verify_ext(rsa, md, (unsigned) hlen, digest, md, use_salt, sig) == 0;
        } else {
            ok = mbedtls_pk_verify(k.pk, md, digest, hlen, sig, slen) == 0;
        }
    }
    fg_c_key_free(&k);
    return JS_NewBool(ctx, ok);
}

static JSValue fg_c_not_ec(JSContext *ctx)
{
    return fg_c_throw(ctx, "ERR_OSSL_EVP_OPERATION_NOT_SUPPORTED_FOR_THIS_KEYTYPE",
                      "error:03000096:digital envelope routines::operation not supported for this keytype", 0);
}

static int fg_c_is_ec(mbedtls_pk_context *pk)
{
    mbedtls_pk_type_t t = mbedtls_pk_get_type(pk);
    return t == MBEDTLS_PK_ECKEY || t == MBEDTLS_PK_ECKEY_DH || t == MBEDTLS_PK_ECDSA;
}

/* pkSignRawEc(key, passphrase, digest): ECDSA-sign a digest the caller already computed (BLAKE2b512/BLAKE2s256,
 * which mbedTLS's own digest table has no entry for — see fg_c_md). Unlike RSA and classic DSA, Node does not
 * restrict which digest ECDSA signs with, and mbedTLS's ECDSA math needs only the digest bytes and their length:
 * mbedtls_ecdsa_read_signature ignores its md_alg argument outright, and the deterministic (RFC 6979) signer only
 * feeds md_alg to the nonce-derivation HMAC-DRBG, which just needs any valid digest to key that DRBG with — it has
 * no bearing on whether the (r, s) it produces verifies. MBEDTLS_MD_NONE is refused there, so SHA-256 stands in. */
static JSValue fg_pk_sign_raw_ec(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    const char *pass = NULL;
    fg_c_input key;
    fg_c_key k;
    size_t dlen = 0, siglen = 0;
    uint8_t *digest;
    unsigned char sig[MBEDTLS_PK_SIGNATURE_MAX_SIZE];
    int ret;

    if (fg_c_input_get(ctx, argv[0], &key)) return JS_EXCEPTION;
    if (JS_IsString(argv[1])) pass = JS_ToCString(ctx, argv[1]);
    digest = JS_GetUint8Array(ctx, &dlen, argv[2]);
    if (!digest) {
        fg_c_release(&key);
        if (pass) JS_FreeCString(ctx, pass);
        return JS_EXCEPTION;
    }
    ret = fg_c_key_load(&k, key.p, key.len, pass, 1);
    fg_c_release(&key);
    if (pass) JS_FreeCString(ctx, pass);
    if (ret != 0) return fg_c_throw(ctx, "ERR_OSSL_UNSUPPORTED", "private key", ret);
    if (!fg_c_is_ec(k.pk)) {
        fg_c_key_free(&k);
        return fg_c_not_ec(ctx);
    }
    ret = mbedtls_pk_sign(k.pk, MBEDTLS_MD_SHA256, digest, dlen, sig, sizeof(sig), &siglen, mbedtls_ctr_drbg_random, &fg_drbg);
    fg_c_key_free(&k);
    if (ret != 0) return fg_c_throw(ctx, "ERR_OSSL_RSA_DIGEST_TOO_BIG_FOR_RSA_KEY", "sign", ret);
    return fg_c_bytes(ctx, sig, siglen);
}

/* pkVerifyRawEc(key, digest, signature): the verify side of pkSignRawEc. mbedtls_ecdsa_read_signature never looks
 * at md_alg, so MBEDTLS_MD_NONE is fine here (only the sign side's nonce derivation needs a real one). */
static JSValue fg_pk_verify_raw_ec(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    fg_c_input key;
    fg_c_key k;
    size_t dlen = 0, slen = 0;
    uint8_t *digest, *sig;
    int ret, ok = 0;

    if (fg_c_input_get(ctx, argv[0], &key)) return JS_EXCEPTION;
    digest = JS_GetUint8Array(ctx, &dlen, argv[1]);
    sig = JS_GetUint8Array(ctx, &slen, argv[2]);
    if (!digest || !sig) {
        fg_c_release(&key);
        return JS_EXCEPTION;
    }
    ret = fg_c_key_load(&k, key.p, key.len, NULL, 0);
    fg_c_release(&key);
    if (ret != 0) return fg_c_throw(ctx, "ERR_OSSL_UNSUPPORTED", "public key", ret);
    if (!fg_c_is_ec(k.pk)) {
        fg_c_key_free(&k);
        return fg_c_not_ec(ctx);
    }
    ok = mbedtls_pk_verify(k.pk, MBEDTLS_MD_NONE, digest, dlen, sig, slen) == 0;
    fg_c_key_free(&k);
    return JS_NewBool(ctx, ok);
}

/* ------------------------------------------------------------------ ECDH */

static int fg_c_ec_grp(const char *name, mbedtls_ecp_group *grp)
{
    mbedtls_ecp_group_id id;
    if (fg_c_curve_id(name, &id) != 0) return -1;
    return mbedtls_ecp_group_load(grp, id);
}

/* ecdhGenerate(curve, privateBytes?) -> { priv, pub } (uncompressed point; the raw key for x25519) */
static JSValue fg_ecdh_generate(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    const char *curve = JS_ToCString(ctx, argv[0]);
    mbedtls_ecp_group grp;
    mbedtls_mpi d;
    mbedtls_ecp_point q;
    unsigned char priv[80], pub[133];
    size_t plen = 0, publen = 0;
    int ret;
    JSValue o;

    if (!curve) return JS_EXCEPTION;
    mbedtls_ecp_group_init(&grp);
    mbedtls_mpi_init(&d);
    mbedtls_ecp_point_init(&q);
    fg_rng_init();
    if (fg_c_ec_grp(curve, &grp) != 0) {
        JS_FreeCString(ctx, curve);
        mbedtls_ecp_group_free(&grp);
        return fg_c_throw(ctx, "ERR_CRYPTO_INVALID_CURVE", "Invalid EC curve name", 0);
    }
    JS_FreeCString(ctx, curve);
    if (argc > 1 && !JS_IsUndefined(argv[1])) {
        size_t n = 0;
        uint8_t *given = JS_GetUint8Array(ctx, &n, argv[1]);
        if (!given) {
            ret = MBEDTLS_ERR_ECP_BAD_INPUT_DATA;
        } else if (mbedtls_ecp_get_type(&grp) == MBEDTLS_ECP_TYPE_MONTGOMERY) {
            ret = mbedtls_mpi_read_binary_le(&d, given, n);
            if (ret == 0) ret = mbedtls_ecp_check_privkey(&grp, &d);
        } else {
            ret = mbedtls_mpi_read_binary(&d, given, n);
            if (ret == 0) ret = mbedtls_ecp_check_privkey(&grp, &d);
        }
        if (ret == 0) ret = mbedtls_ecp_mul(&grp, &q, &d, &grp.G, mbedtls_ctr_drbg_random, &fg_drbg);
    } else {
        ret = mbedtls_ecdh_gen_public(&grp, &d, &q, mbedtls_ctr_drbg_random, &fg_drbg);
    }
    if (ret == 0) {
        plen = (grp.nbits + 7) / 8;
        if (mbedtls_ecp_get_type(&grp) == MBEDTLS_ECP_TYPE_MONTGOMERY) {
            ret = mbedtls_mpi_write_binary_le(&d, priv, plen);
        } else {
            ret = mbedtls_mpi_write_binary(&d, priv, plen);
        }
    }
    if (ret == 0) ret = mbedtls_ecp_point_write_binary(&grp, &q, MBEDTLS_ECP_PF_UNCOMPRESSED, &publen, pub, sizeof(pub));
    if (ret != 0) {
        mbedtls_ecp_group_free(&grp);
        mbedtls_mpi_free(&d);
        mbedtls_ecp_point_free(&q);
        return fg_c_throw(ctx, "ERR_CRYPTO_OPERATION_FAILED", "ECDH key", ret);
    }
    o = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, o, "priv", fg_c_bytes(ctx, priv, plen));
    JS_SetPropertyStr(ctx, o, "pub", fg_c_bytes(ctx, pub, publen));
    mbedtls_ecp_group_free(&grp);
    mbedtls_mpi_free(&d);
    mbedtls_ecp_point_free(&q);
    return o;
}

/* ecdhCompute(curve, priv, peerPub) -> shared secret */
static JSValue fg_ecdh_compute(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    const char *curve = JS_ToCString(ctx, argv[0]);
    mbedtls_ecp_group grp;
    mbedtls_mpi d, z;
    mbedtls_ecp_point q;
    size_t pn = 0, qn = 0, zlen;
    uint8_t *priv, *peer;
    unsigned char out[80];
    int ret, stage = 0;

    if (!curve) return JS_EXCEPTION;
    mbedtls_ecp_group_init(&grp);
    mbedtls_mpi_init(&d);
    mbedtls_mpi_init(&z);
    mbedtls_ecp_point_init(&q);
    fg_rng_init();
    if (fg_c_ec_grp(curve, &grp) != 0) {
        JS_FreeCString(ctx, curve);
        mbedtls_ecp_group_free(&grp);
        return fg_c_throw(ctx, "ERR_CRYPTO_INVALID_CURVE", "Invalid EC curve name", 0);
    }
    JS_FreeCString(ctx, curve);
    priv = JS_GetUint8Array(ctx, &pn, argv[1]);
    peer = JS_GetUint8Array(ctx, &qn, argv[2]);
    if (!priv || !peer) {
        mbedtls_ecp_group_free(&grp);
        return JS_EXCEPTION;
    }
    if (mbedtls_ecp_get_type(&grp) == MBEDTLS_ECP_TYPE_MONTGOMERY) {
        ret = mbedtls_mpi_read_binary_le(&d, priv, pn);
    } else {
        ret = mbedtls_mpi_read_binary(&d, priv, pn);
    }
    if (ret == 0) {
        ret = mbedtls_ecp_point_read_binary(&grp, &q, peer, qn);
        if (ret != 0) stage = 1;
    }
    if (ret == 0 && qn == 1) {
        ret = MBEDTLS_ERR_ECP_INVALID_KEY;
        stage = 1;
    }
    if (ret == 0) ret = mbedtls_ecp_check_pubkey(&grp, &q);
    if (ret == 0) ret = mbedtls_ecdh_compute_shared(&grp, &z, &q, &d, mbedtls_ctr_drbg_random, &fg_drbg);
    zlen = (grp.nbits + 7) / 8;
    if (ret == 0) {
        ret = mbedtls_ecp_get_type(&grp) == MBEDTLS_ECP_TYPE_MONTGOMERY ? mbedtls_mpi_write_binary_le(&z, out, zlen)
                                                                        : mbedtls_mpi_write_binary(&z, out, zlen);
    }
    mbedtls_ecp_group_free(&grp);
    mbedtls_mpi_free(&d);
    mbedtls_mpi_free(&z);
    mbedtls_ecp_point_free(&q);
    if (ret != 0) {
        if (stage == 1) return fg_c_throw(ctx, "ERR_CRYPTO_OPERATION_FAILED", "Failed to compute ECDH key", 0);
        return fg_c_throw(ctx, "ERR_CRYPTO_ECDH_INVALID_PUBLIC_KEY", "Public key is not valid for specified curve", 0);
    }
    return fg_c_bytes(ctx, out, zlen);
}

/* ecdhConvert(curve, point, format): 0 compressed, 1 uncompressed. Also validates the point. */
static JSValue fg_ecdh_convert(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    const char *curve = JS_ToCString(ctx, argv[0]);
    mbedtls_ecp_group grp;
    mbedtls_ecp_point q;
    size_t n = 0, outn = 0;
    uint8_t *pt;
    int32_t fmt = 1;
    unsigned char out[133];
    int ret;

    if (!curve) return JS_EXCEPTION;
    mbedtls_ecp_group_init(&grp);
    mbedtls_ecp_point_init(&q);
    if (fg_c_ec_grp(curve, &grp) != 0) {
        JS_FreeCString(ctx, curve);
        mbedtls_ecp_group_free(&grp);
        return fg_c_throw(ctx, "ERR_CRYPTO_INVALID_CURVE", "Invalid EC curve name", 0);
    }
    JS_FreeCString(ctx, curve);
    pt = JS_GetUint8Array(ctx, &n, argv[1]);
    if (!pt) {
        mbedtls_ecp_group_free(&grp);
        return JS_EXCEPTION;
    }
    if (argc > 2) JS_ToInt32(ctx, &fmt, argv[2]);
    ret = mbedtls_ecp_point_read_binary(&grp, &q, pt, n);
    if (ret == 0) ret = mbedtls_ecp_check_pubkey(&grp, &q);
    if (ret == 0) {
        ret = mbedtls_ecp_point_write_binary(&grp, &q, fmt ? MBEDTLS_ECP_PF_UNCOMPRESSED : MBEDTLS_ECP_PF_COMPRESSED, &outn,
                                             out, sizeof(out));
    }
    mbedtls_ecp_group_free(&grp);
    mbedtls_ecp_point_free(&q);
    if (ret != 0) return fg_c_throw(ctx, "ERR_CRYPTO_ECDH_INVALID_PUBLIC_KEY", "Public key is not valid for specified curve", ret);
    return fg_c_bytes(ctx, out, outn);
}

/* ------------------------------------------------------------------ primes */

/* genPrime(bits, safe) -> big-endian bytes */
static JSValue fg_gen_prime(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    int32_t bits = 0, safe = 0;
    mbedtls_mpi p;
    int ret;
    JSValue v;

    JS_ToInt32(ctx, &bits, argv[0]);
    if (argc > 1) safe = JS_ToBool(ctx, argv[1]);
    if (bits < 3 || bits > 16384) return fg_c_throw(ctx, "ERR_OUT_OF_RANGE", "The value of \"size\" is out of range.", 0);
    fg_rng_init();
    mbedtls_mpi_init(&p);
    ret = mbedtls_mpi_gen_prime(&p, (size_t) bits, safe ? MBEDTLS_MPI_GEN_PRIME_FLAG_DH : 0, mbedtls_ctr_drbg_random, &fg_drbg);
    if (ret != 0) {
        mbedtls_mpi_free(&p);
        return fg_c_throw(ctx, "ERR_CRYPTO_OPERATION_FAILED", "prime generation", ret);
    }
    v = fg_c_mpi(ctx, &p);
    mbedtls_mpi_free(&p);
    return v;
}

/* isPrime(bytes, rounds) */
static JSValue fg_is_prime(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    size_t n = 0;
    uint8_t *b = JS_GetUint8Array(ctx, &n, argv[0]);
    int32_t rounds = 0;
    mbedtls_mpi p;
    int ret;

    if (!b) return JS_EXCEPTION;
    if (argc > 1) JS_ToInt32(ctx, &rounds, argv[1]);
    if (rounds <= 0 || rounds > 250) rounds = 40;
    fg_rng_init();
    mbedtls_mpi_init(&p);
    ret = mbedtls_mpi_read_binary(&p, b, n);
    if (ret == 0) ret = mbedtls_mpi_is_prime_ext(&p, rounds, mbedtls_ctr_drbg_random, &fg_drbg);
    mbedtls_mpi_free(&p);
    return JS_NewBool(ctx, ret == 0);
}


/* ------------------------------------------------------------------ SHAKE (Keccak) */

static const uint64_t fg_keccak_rc[24] = {
    0x0000000000000001ULL, 0x0000000000008082ULL, 0x800000000000808aULL, 0x8000000080008000ULL, 0x000000000000808bULL,
    0x0000000080000001ULL, 0x8000000080008081ULL, 0x8000000000008009ULL, 0x000000000000008aULL, 0x0000000000000088ULL,
    0x0000000080008009ULL, 0x000000008000000aULL, 0x000000008000808bULL, 0x800000000000008bULL, 0x8000000000008089ULL,
    0x8000000000008003ULL, 0x8000000000008002ULL, 0x8000000000000080ULL, 0x000000000000800aULL, 0x800000008000000aULL,
    0x8000000080008081ULL, 0x8000000000008080ULL, 0x0000000080000001ULL, 0x8000000080008008ULL};
static const int fg_keccak_rot[24] = {1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 2, 14, 27, 41, 56, 8, 25, 43, 62, 18, 39, 61, 20, 44};
static const int fg_keccak_pi[24] = {10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4, 15, 23, 19, 13, 12, 2, 20, 14, 22, 9, 6, 1};

static uint64_t fg_rol64(uint64_t x, int n)
{
    return (x << n) | (x >> (64 - n));
}

static void fg_keccak_f_from(uint64_t st[25], int first)
{
    int round, i, j;
    uint64_t bc[5], t;
    for (round = first; round < 24; round++) {
        for (i = 0; i < 5; i++) {
            bc[i] = st[i] ^ st[i + 5] ^ st[i + 10] ^ st[i + 15] ^ st[i + 20];
        }
        for (i = 0; i < 5; i++) {
            t = bc[(i + 4) % 5] ^ fg_rol64(bc[(i + 1) % 5], 1);
            for (j = 0; j < 25; j += 5) {
                st[j + i] ^= t;
            }
        }
        t = st[1];
        for (i = 0; i < 24; i++) {
            j = fg_keccak_pi[i];
            bc[0] = st[j];
            st[j] = fg_rol64(t, fg_keccak_rot[i]);
            t = bc[0];
        }
        for (j = 0; j < 25; j += 5) {
            for (i = 0; i < 5; i++) {
                bc[i] = st[j + i];
            }
            for (i = 0; i < 5; i++) {
                st[j + i] ^= (~bc[(i + 1) % 5]) & bc[(i + 2) % 5];
            }
        }
        st[0] ^= fg_keccak_rc[round];
    }
}

static void fg_keccak_f(uint64_t st[25])
{
    fg_keccak_f_from(st, 0);
}

/* SHAKE128 (rate 168) or SHAKE256 (rate 136) of up to two inputs, `outlen` bytes out. */
static void fg_shake(int bits, const unsigned char *a, size_t alen, const unsigned char *b, size_t blen, const unsigned char *c,
                     size_t clen, unsigned char *out, size_t outlen)
{
    uint64_t st[25];
    unsigned char block[200];
    size_t rate = bits == 128 ? 168 : 136;
    size_t used = 0, i, produced = 0;
    const unsigned char *parts[3] = {a, b, c};
    size_t lens[3] = {alen, blen, clen};
    int part;

    memset(st, 0, sizeof(st));
    memset(block, 0, sizeof(block));
    for (part = 0; part < 3; part++) {
        size_t off = 0;
        while (off < lens[part]) {
            size_t take = rate - used;
            if (take > lens[part] - off) take = lens[part] - off;
            for (i = 0; i < take; i++) block[used + i] ^= parts[part][off + i];
            used += take;
            off += take;
            if (used == rate) {
                for (i = 0; i < rate / 8; i++) {
                    uint64_t lane = 0;
                    int k;
                    for (k = 7; k >= 0; k--) lane = (lane << 8) | block[i * 8 + (size_t) k];
                    st[i] ^= lane;
                }
                fg_keccak_f(st);
                memset(block, 0, sizeof(block));
                used = 0;
            }
        }
    }
    block[used] ^= 0x1f;
    block[rate - 1] ^= 0x80;
    for (i = 0; i < rate / 8; i++) {
        uint64_t lane = 0;
        int k;
        for (k = 7; k >= 0; k--) lane = (lane << 8) | block[i * 8 + (size_t) k];
        st[i] ^= lane;
    }
    fg_keccak_f(st);
    while (produced < outlen) {
        size_t n = outlen - produced < rate ? outlen - produced : rate;
        for (i = 0; i < n; i++) out[produced + i] = (unsigned char) (st[i / 8] >> (8 * (i % 8)));
        produced += n;
        if (produced < outlen) fg_keccak_f(st);
    }
}

/* keccak(bits, bytes, outputLength) -> SHAKE128/256 digest */
static JSValue fg_keccak_js(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    int32_t bits = 256;
    size_t n = 0;
    uint32_t outlen = 32;
    uint8_t *data;
    unsigned char *out;
    JSValue v;

    JS_ToInt32(ctx, &bits, argv[0]);
    data = JS_GetUint8Array(ctx, &n, argv[1]);
    if (!data) return JS_EXCEPTION;
    if (argc > 2) JS_ToUint32(ctx, &outlen, argv[2]);
    if (bits != 128 && bits != 256) return fg_c_throw(ctx, "ERR_INVALID_ARG_VALUE", "SHAKE needs 128 or 256", 0);
    out = malloc(outlen ? outlen : 1);
    if (!out) return JS_ThrowOutOfMemory(ctx);
    fg_shake(bits, data, n, NULL, 0, NULL, 0, out, outlen);
    v = fg_c_bytes(ctx, out, outlen);
    free(out);
    return v;
}

/* ------------------------------------------------------------------ EdDSA (RFC 8032): Ed25519 and Ed448 */

typedef struct {
    int is448;
    size_t enc_len;   /* bytes in an encoded point or scalar: 32 or 57 */
    size_t field_len; /* bytes of y inside it: 32 or 56 */
    mbedtls_mpi p, d, a, L, bx, by, tmp1, tmp2, tmp3, tmp4, tmp5, tmp6;
} fg_ed;

typedef struct {
    mbedtls_mpi x, y, z;
} fg_ed_point;

#define FG_ED_MM(r, x, y) \
    do { \
        MBEDTLS_MPI_CHK(mbedtls_mpi_mul_mpi((r), (x), (y))); \
        MBEDTLS_MPI_CHK(mbedtls_mpi_mod_mpi((r), (r), &ed->p)); \
    } while (0)

static void fg_ed_free(fg_ed *ed)
{
    mbedtls_mpi_free(&ed->p);
    mbedtls_mpi_free(&ed->d);
    mbedtls_mpi_free(&ed->a);
    mbedtls_mpi_free(&ed->L);
    mbedtls_mpi_free(&ed->bx);
    mbedtls_mpi_free(&ed->by);
    mbedtls_mpi_free(&ed->tmp1);
    mbedtls_mpi_free(&ed->tmp2);
    mbedtls_mpi_free(&ed->tmp3);
    mbedtls_mpi_free(&ed->tmp4);
    mbedtls_mpi_free(&ed->tmp5);
    mbedtls_mpi_free(&ed->tmp6);
}

static int fg_ed_init(fg_ed *ed, int is448)
{
    int ret = 0;
    mbedtls_mpi t;
    memset(ed, 0, sizeof(*ed));
    ed->is448 = is448;
    mbedtls_mpi_init(&ed->p);
    mbedtls_mpi_init(&ed->d);
    mbedtls_mpi_init(&ed->a);
    mbedtls_mpi_init(&ed->L);
    mbedtls_mpi_init(&ed->bx);
    mbedtls_mpi_init(&ed->by);
    mbedtls_mpi_init(&ed->tmp1);
    mbedtls_mpi_init(&ed->tmp2);
    mbedtls_mpi_init(&ed->tmp3);
    mbedtls_mpi_init(&ed->tmp4);
    mbedtls_mpi_init(&ed->tmp5);
    mbedtls_mpi_init(&ed->tmp6);
    mbedtls_mpi_init(&t);
    if (!is448) {
        ed->enc_len = 32;
        ed->field_len = 32;
        /* p = 2^255 - 19 */
        MBEDTLS_MPI_CHK(mbedtls_mpi_lset(&ed->p, 1));
        MBEDTLS_MPI_CHK(mbedtls_mpi_shift_l(&ed->p, 255));
        MBEDTLS_MPI_CHK(mbedtls_mpi_sub_int(&ed->p, &ed->p, 19));
        MBEDTLS_MPI_CHK(mbedtls_mpi_read_string(&ed->d, 10, "37095705934669439343138083508754565189542113879843219016388785533085940283555"));
        MBEDTLS_MPI_CHK(mbedtls_mpi_sub_int(&ed->a, &ed->p, 1));
        MBEDTLS_MPI_CHK(mbedtls_mpi_read_string(&ed->L, 10, "7237005577332262213973186563042994240857116359379907606001950938285454250989"));
        MBEDTLS_MPI_CHK(mbedtls_mpi_read_string(&ed->bx, 10, "15112221349535400772501151409588531511454012693041857206046113283949847762202"));
        MBEDTLS_MPI_CHK(mbedtls_mpi_read_string(&ed->by, 10, "46316835694926478169428394003475163141307993866256225615783033603165251855960"));
    } else {
        ed->enc_len = 57;
        ed->field_len = 56;
        /* p = 2^448 - 2^224 - 1 */
        MBEDTLS_MPI_CHK(mbedtls_mpi_lset(&ed->p, 1));
        MBEDTLS_MPI_CHK(mbedtls_mpi_shift_l(&ed->p, 448));
        MBEDTLS_MPI_CHK(mbedtls_mpi_lset(&t, 1));
        MBEDTLS_MPI_CHK(mbedtls_mpi_shift_l(&t, 224));
        MBEDTLS_MPI_CHK(mbedtls_mpi_sub_mpi(&ed->p, &ed->p, &t));
        MBEDTLS_MPI_CHK(mbedtls_mpi_sub_int(&ed->p, &ed->p, 1));
        MBEDTLS_MPI_CHK(mbedtls_mpi_lset(&ed->d, 39081));
        MBEDTLS_MPI_CHK(mbedtls_mpi_sub_mpi(&ed->d, &ed->p, &ed->d));
        MBEDTLS_MPI_CHK(mbedtls_mpi_lset(&ed->a, 1));
        MBEDTLS_MPI_CHK(mbedtls_mpi_read_string(&ed->L, 10, "181709681073901722637330951972001133588410340171829515070372549795146003961539585716195755291692375963310293709091662304773755859649779"));
        MBEDTLS_MPI_CHK(mbedtls_mpi_read_string(&ed->bx, 10, "224580040295924300187604334099896036246789641632564134246125461686950415467406032909029192869357953282578032075146446173674602635247710"));
        MBEDTLS_MPI_CHK(mbedtls_mpi_read_string(&ed->by, 10, "298819210078481492676017930443930673437544040154080242095928241372331506189835876003536878655418784733982303233503462500531545062832660"));
    }
cleanup:
    mbedtls_mpi_free(&t);
    return ret;
}

static void fg_edp_init(fg_ed_point *q)
{
    mbedtls_mpi_init(&q->x);
    mbedtls_mpi_init(&q->y);
    mbedtls_mpi_init(&q->z);
}

static void fg_edp_free(fg_ed_point *q)
{
    mbedtls_mpi_free(&q->x);
    mbedtls_mpi_free(&q->y);
    mbedtls_mpi_free(&q->z);
}

static int fg_edp_identity(fg_ed_point *q)
{
    int ret;
    MBEDTLS_MPI_CHK(mbedtls_mpi_lset(&q->x, 0));
    MBEDTLS_MPI_CHK(mbedtls_mpi_lset(&q->y, 1));
    MBEDTLS_MPI_CHK(mbedtls_mpi_lset(&q->z, 1));
cleanup:
    return ret;
}

/* r = p1 + p2 on the twisted Edwards curve a*x^2 + y^2 = 1 + d*x^2*y^2 (complete formulas, projective coordinates). */
static int fg_edp_add(fg_ed *ed, fg_ed_point *r, const fg_ed_point *p1, const fg_ed_point *p2)
{
    int ret;
    mbedtls_mpi *A = &ed->tmp1, *B = &ed->tmp2, *C = &ed->tmp3, *D = &ed->tmp4, *E = &ed->tmp5, *F = &ed->tmp6;
    mbedtls_mpi G, H, X3, Y3, Z3;
    mbedtls_mpi_init(&G);
    mbedtls_mpi_init(&H);
    mbedtls_mpi_init(&X3);
    mbedtls_mpi_init(&Y3);
    mbedtls_mpi_init(&Z3);
    FG_ED_MM(A, &p1->z, &p2->z);               /* A = Z1*Z2 */
    FG_ED_MM(B, A, A);                         /* B = A^2 */
    FG_ED_MM(C, &p1->x, &p2->x);               /* C = X1*X2 */
    FG_ED_MM(D, &p1->y, &p2->y);               /* D = Y1*Y2 */
    FG_ED_MM(E, C, D);
    FG_ED_MM(E, E, &ed->d);                    /* E = d*C*D */
    MBEDTLS_MPI_CHK(mbedtls_mpi_sub_mpi(F, B, E));
    MBEDTLS_MPI_CHK(mbedtls_mpi_mod_mpi(F, F, &ed->p)); /* F = B-E */
    MBEDTLS_MPI_CHK(mbedtls_mpi_add_mpi(&G, B, E));
    MBEDTLS_MPI_CHK(mbedtls_mpi_mod_mpi(&G, &G, &ed->p)); /* G = B+E */
    /* X3 = A*F*((X1+Y1)*(X2+Y2)-C-D) */
    MBEDTLS_MPI_CHK(mbedtls_mpi_add_mpi(&H, &p1->x, &p1->y));
    MBEDTLS_MPI_CHK(mbedtls_mpi_add_mpi(&X3, &p2->x, &p2->y));
    MBEDTLS_MPI_CHK(mbedtls_mpi_mul_mpi(&H, &H, &X3));
    MBEDTLS_MPI_CHK(mbedtls_mpi_sub_mpi(&H, &H, C));
    MBEDTLS_MPI_CHK(mbedtls_mpi_sub_mpi(&H, &H, D));
    MBEDTLS_MPI_CHK(mbedtls_mpi_mod_mpi(&H, &H, &ed->p));
    MBEDTLS_MPI_CHK(mbedtls_mpi_mul_mpi(&X3, A, F));
    MBEDTLS_MPI_CHK(mbedtls_mpi_mod_mpi(&X3, &X3, &ed->p));
    MBEDTLS_MPI_CHK(mbedtls_mpi_mul_mpi(&X3, &X3, &H));
    MBEDTLS_MPI_CHK(mbedtls_mpi_mod_mpi(&X3, &X3, &ed->p));
    /* Y3 = A*G*(D - a*C) */
    MBEDTLS_MPI_CHK(mbedtls_mpi_mul_mpi(&H, &ed->a, C));
    MBEDTLS_MPI_CHK(mbedtls_mpi_mod_mpi(&H, &H, &ed->p));
    MBEDTLS_MPI_CHK(mbedtls_mpi_sub_mpi(&H, D, &H));
    MBEDTLS_MPI_CHK(mbedtls_mpi_mod_mpi(&H, &H, &ed->p));
    MBEDTLS_MPI_CHK(mbedtls_mpi_mul_mpi(&Y3, A, &G));
    MBEDTLS_MPI_CHK(mbedtls_mpi_mod_mpi(&Y3, &Y3, &ed->p));
    MBEDTLS_MPI_CHK(mbedtls_mpi_mul_mpi(&Y3, &Y3, &H));
    MBEDTLS_MPI_CHK(mbedtls_mpi_mod_mpi(&Y3, &Y3, &ed->p));
    /* Z3 = F*G */
    MBEDTLS_MPI_CHK(mbedtls_mpi_mul_mpi(&Z3, F, &G));
    MBEDTLS_MPI_CHK(mbedtls_mpi_mod_mpi(&Z3, &Z3, &ed->p));
    MBEDTLS_MPI_CHK(mbedtls_mpi_copy(&r->x, &X3));
    MBEDTLS_MPI_CHK(mbedtls_mpi_copy(&r->y, &Y3));
    MBEDTLS_MPI_CHK(mbedtls_mpi_copy(&r->z, &Z3));
cleanup:
    mbedtls_mpi_free(&G);
    mbedtls_mpi_free(&H);
    mbedtls_mpi_free(&X3);
    mbedtls_mpi_free(&Y3);
    mbedtls_mpi_free(&Z3);
    return ret;
}

/* r = k * p (double and add from the top bit). */
static int fg_edp_mul(fg_ed *ed, fg_ed_point *r, const mbedtls_mpi *k, const fg_ed_point *p)
{
    int ret;
    size_t bits = mbedtls_mpi_bitlen(k), i;
    fg_ed_point acc;
    fg_edp_init(&acc);
    MBEDTLS_MPI_CHK(fg_edp_identity(&acc));
    for (i = bits; i > 0; i--) {
        MBEDTLS_MPI_CHK(fg_edp_add(ed, &acc, &acc, &acc));
        if (mbedtls_mpi_get_bit(k, i - 1)) {
            MBEDTLS_MPI_CHK(fg_edp_add(ed, &acc, &acc, p));
        }
    }
    MBEDTLS_MPI_CHK(mbedtls_mpi_copy(&r->x, &acc.x));
    MBEDTLS_MPI_CHK(mbedtls_mpi_copy(&r->y, &acc.y));
    MBEDTLS_MPI_CHK(mbedtls_mpi_copy(&r->z, &acc.z));
cleanup:
    fg_edp_free(&acc);
    return ret;
}

/* Affine x and y of a projective point. */
static int fg_edp_affine(fg_ed *ed, mbedtls_mpi *x, mbedtls_mpi *y, const fg_ed_point *q)
{
    int ret;
    mbedtls_mpi zinv;
    mbedtls_mpi_init(&zinv);
    MBEDTLS_MPI_CHK(mbedtls_mpi_inv_mod(&zinv, &q->z, &ed->p));
    MBEDTLS_MPI_CHK(mbedtls_mpi_mul_mpi(x, &q->x, &zinv));
    MBEDTLS_MPI_CHK(mbedtls_mpi_mod_mpi(x, x, &ed->p));
    MBEDTLS_MPI_CHK(mbedtls_mpi_mul_mpi(y, &q->y, &zinv));
    MBEDTLS_MPI_CHK(mbedtls_mpi_mod_mpi(y, y, &ed->p));
cleanup:
    mbedtls_mpi_free(&zinv);
    return ret;
}

static int fg_edp_encode(fg_ed *ed, unsigned char *out, const fg_ed_point *q)
{
    int ret;
    mbedtls_mpi x, y;
    mbedtls_mpi_init(&x);
    mbedtls_mpi_init(&y);
    MBEDTLS_MPI_CHK(fg_edp_affine(ed, &x, &y, q));
    memset(out, 0, ed->enc_len);
    MBEDTLS_MPI_CHK(mbedtls_mpi_write_binary_le(&y, out, ed->field_len));
    if (mbedtls_mpi_get_bit(&x, 0)) {
        out[ed->enc_len - 1] |= 0x80;
    }
cleanup:
    mbedtls_mpi_free(&x);
    mbedtls_mpi_free(&y);
    return ret;
}

/* Returns 0 for a valid point; a nonzero code when the bytes are not one. */
static int fg_edp_decode(fg_ed *ed, fg_ed_point *q, const unsigned char *in)
{
    int ret, sign = (in[ed->enc_len - 1] & 0x80) != 0;
    unsigned char ybytes[57];
    mbedtls_mpi y, u, v, x, t, e;
    mbedtls_mpi_init(&y);
    mbedtls_mpi_init(&u);
    mbedtls_mpi_init(&v);
    mbedtls_mpi_init(&x);
    mbedtls_mpi_init(&t);
    mbedtls_mpi_init(&e);
    memcpy(ybytes, in, ed->enc_len);
    ybytes[ed->enc_len - 1] &= 0x7f;
    MBEDTLS_MPI_CHK(mbedtls_mpi_read_binary_le(&y, ybytes, ed->enc_len));
    if (mbedtls_mpi_cmp_mpi(&y, &ed->p) >= 0) {
        ret = -1;
        goto cleanup;
    }
    /* x^2 = (y^2 - 1) / (d*y^2 - a) */
    MBEDTLS_MPI_CHK(mbedtls_mpi_mul_mpi(&u, &y, &y));
    MBEDTLS_MPI_CHK(mbedtls_mpi_mod_mpi(&u, &u, &ed->p));
    MBEDTLS_MPI_CHK(mbedtls_mpi_mul_mpi(&v, &u, &ed->d));
    MBEDTLS_MPI_CHK(mbedtls_mpi_sub_mpi(&v, &v, &ed->a));
    MBEDTLS_MPI_CHK(mbedtls_mpi_mod_mpi(&v, &v, &ed->p));
    MBEDTLS_MPI_CHK(mbedtls_mpi_sub_int(&u, &u, 1));
    MBEDTLS_MPI_CHK(mbedtls_mpi_mod_mpi(&u, &u, &ed->p));
    MBEDTLS_MPI_CHK(mbedtls_mpi_inv_mod(&t, &v, &ed->p));
    MBEDTLS_MPI_CHK(mbedtls_mpi_mul_mpi(&t, &t, &u));
    MBEDTLS_MPI_CHK(mbedtls_mpi_mod_mpi(&t, &t, &ed->p)); /* t = u / v */
    if (ed->is448) {
        /* p = 3 mod 4: x = t^((p+1)/4) */
        MBEDTLS_MPI_CHK(mbedtls_mpi_add_int(&e, &ed->p, 1));
        MBEDTLS_MPI_CHK(mbedtls_mpi_shift_r(&e, 2));
        MBEDTLS_MPI_CHK(mbedtls_mpi_exp_mod(&x, &t, &e, &ed->p, NULL));
    } else {
        /* p = 5 mod 8: x = t^((p+3)/8), times sqrt(-1) = 2^((p-1)/4) when x^2 is -t */
        MBEDTLS_MPI_CHK(mbedtls_mpi_add_int(&e, &ed->p, 3));
        MBEDTLS_MPI_CHK(mbedtls_mpi_shift_r(&e, 3));
        MBEDTLS_MPI_CHK(mbedtls_mpi_exp_mod(&x, &t, &e, &ed->p, NULL));
        MBEDTLS_MPI_CHK(mbedtls_mpi_mul_mpi(&u, &x, &x));
        MBEDTLS_MPI_CHK(mbedtls_mpi_mod_mpi(&u, &u, &ed->p));
        if (mbedtls_mpi_cmp_mpi(&u, &t) != 0) {
            mbedtls_mpi two;
            mbedtls_mpi_init(&two);
            ret = mbedtls_mpi_lset(&two, 2);
            if (ret == 0) ret = mbedtls_mpi_sub_int(&e, &ed->p, 1);
            if (ret == 0) ret = mbedtls_mpi_shift_r(&e, 2);
            if (ret == 0) ret = mbedtls_mpi_exp_mod(&v, &two, &e, &ed->p, NULL);
            if (ret == 0) ret = mbedtls_mpi_mul_mpi(&x, &x, &v);
            if (ret == 0) ret = mbedtls_mpi_mod_mpi(&x, &x, &ed->p);
            mbedtls_mpi_free(&two);
            if (ret != 0) goto cleanup;
        }
    }
    MBEDTLS_MPI_CHK(mbedtls_mpi_mul_mpi(&u, &x, &x));
    MBEDTLS_MPI_CHK(mbedtls_mpi_mod_mpi(&u, &u, &ed->p));
    if (mbedtls_mpi_cmp_mpi(&u, &t) != 0) {
        ret = -2;
        goto cleanup;
    }
    if (mbedtls_mpi_cmp_int(&x, 0) == 0 && sign) {
        ret = -3;
        goto cleanup;
    }
    if ((mbedtls_mpi_get_bit(&x, 0) != 0) != sign) {
        MBEDTLS_MPI_CHK(mbedtls_mpi_sub_mpi(&x, &ed->p, &x));
    }
    MBEDTLS_MPI_CHK(mbedtls_mpi_copy(&q->x, &x));
    MBEDTLS_MPI_CHK(mbedtls_mpi_copy(&q->y, &y));
    MBEDTLS_MPI_CHK(mbedtls_mpi_lset(&q->z, 1));
cleanup:
    mbedtls_mpi_free(&y);
    mbedtls_mpi_free(&u);
    mbedtls_mpi_free(&v);
    mbedtls_mpi_free(&x);
    mbedtls_mpi_free(&t);
    mbedtls_mpi_free(&e);
    return ret;
}

/* H(a || b || c), 64 bytes (Ed25519, SHA-512) or 114 bytes (Ed448, SHAKE256 with the dom4 prefix), out length returned. */
static int fg_ed_hash(fg_ed *ed, unsigned char *out, const unsigned char *a, size_t alen, const unsigned char *b, size_t blen,
                      const unsigned char *c, size_t clen)
{
    if (!ed->is448) {
        mbedtls_md_context_t md;
        int ret;
        mbedtls_md_init(&md);
        ret = mbedtls_md_setup(&md, mbedtls_md_info_from_type(MBEDTLS_MD_SHA512), 0);
        if (ret == 0) ret = mbedtls_md_starts(&md);
        if (ret == 0 && alen) ret = mbedtls_md_update(&md, a, alen);
        if (ret == 0 && blen) ret = mbedtls_md_update(&md, b, blen);
        if (ret == 0 && clen) ret = mbedtls_md_update(&md, c, clen);
        if (ret == 0) ret = mbedtls_md_finish(&md, out);
        mbedtls_md_free(&md);
        return ret == 0 ? 64 : -1;
    }
    {
        /* dom4(0, "") = "SigEd448" || 0x00 || 0x00 goes before the first input of signing hashes; key expansion has none. */
        fg_shake(256, a, alen, b, blen, c, clen, out, 114);
        return 114;
    }
}

/* Reads a little-endian hash of `len` bytes as an integer mod L. */
static int fg_ed_scalar(fg_ed *ed, mbedtls_mpi *r, const unsigned char *h, size_t len)
{
    int ret;
    MBEDTLS_MPI_CHK(mbedtls_mpi_read_binary_le(r, h, len));
    MBEDTLS_MPI_CHK(mbedtls_mpi_mod_mpi(r, r, &ed->L));
cleanup:
    return ret;
}

/* Expands a seed: the secret scalar `a` (clamped) and the 32 or 57 byte prefix. */
static int fg_ed_expand(fg_ed *ed, const unsigned char *seed, mbedtls_mpi *a, unsigned char *prefix)
{
    unsigned char h[114];
    int n = fg_ed_hash(ed, h, seed, ed->enc_len, NULL, 0, NULL, 0);
    int ret;
    if (n < 0) return -1;
    if (!ed->is448) {
        h[0] &= 248;
        h[31] &= 127;
        h[31] |= 64;
        MBEDTLS_MPI_CHK(mbedtls_mpi_read_binary_le(a, h, 32));
        memcpy(prefix, h + 32, 32);
    } else {
        h[0] &= 252;
        h[55] |= 128;
        h[56] = 0;
        MBEDTLS_MPI_CHK(mbedtls_mpi_read_binary_le(a, h, 57));
        memcpy(prefix, h + 57, 57);
    }
cleanup:
    return ret;
}

static int fg_ed_public(fg_ed *ed, const unsigned char *seed, unsigned char *pub)
{
    int ret;
    mbedtls_mpi a;
    unsigned char prefix[57];
    fg_ed_point b, q;
    mbedtls_mpi_init(&a);
    fg_edp_init(&b);
    fg_edp_init(&q);
    MBEDTLS_MPI_CHK(fg_ed_expand(ed, seed, &a, prefix));
    MBEDTLS_MPI_CHK(mbedtls_mpi_copy(&b.x, &ed->bx));
    MBEDTLS_MPI_CHK(mbedtls_mpi_copy(&b.y, &ed->by));
    MBEDTLS_MPI_CHK(mbedtls_mpi_lset(&b.z, 1));
    MBEDTLS_MPI_CHK(fg_edp_mul(ed, &q, &a, &b));
    MBEDTLS_MPI_CHK(fg_edp_encode(ed, pub, &q));
cleanup:
    mbedtls_mpi_free(&a);
    fg_edp_free(&b);
    fg_edp_free(&q);
    return ret;
}

static const unsigned char fg_dom4[10] = {'S', 'i', 'g', 'E', 'd', '4', '4', '8', 0, 0};

/* Hash for signing: Ed25519 is plain SHA-512, Ed448 prefixes dom4(0, ""). */
static int fg_ed_sign_hash(fg_ed *ed, unsigned char *out, const unsigned char *a, size_t alen, const unsigned char *b, size_t blen,
                           const unsigned char *m, size_t mlen)
{
    if (!ed->is448) {
        mbedtls_md_context_t md;
        int ret;
        mbedtls_md_init(&md);
        ret = mbedtls_md_setup(&md, mbedtls_md_info_from_type(MBEDTLS_MD_SHA512), 0);
        if (ret == 0) ret = mbedtls_md_starts(&md);
        if (ret == 0) ret = mbedtls_md_update(&md, a, alen);
        if (ret == 0 && blen) ret = mbedtls_md_update(&md, b, blen);
        if (ret == 0 && mlen) ret = mbedtls_md_update(&md, m, mlen);
        if (ret == 0) ret = mbedtls_md_finish(&md, out);
        mbedtls_md_free(&md);
        return ret == 0 ? 64 : -1;
    }
    {
        /* SHAKE256(dom4 || a || b || m): four inputs, so a and b are joined first. */
        unsigned char *joined = malloc(sizeof(fg_dom4) + alen + blen);
        if (!joined) return -1;
        memcpy(joined, fg_dom4, sizeof(fg_dom4));
        memcpy(joined + sizeof(fg_dom4), a, alen);
        if (blen) memcpy(joined + sizeof(fg_dom4) + alen, b, blen);
        fg_shake(256, joined, sizeof(fg_dom4) + alen + blen, m, mlen, NULL, 0, out, 114);
        free(joined);
        return 114;
    }
}

static int fg_ed_sign(fg_ed *ed, const unsigned char *seed, const unsigned char *msg, size_t mlen, unsigned char *sig)
{
    int ret;
    mbedtls_mpi a, r, k, s;
    unsigned char prefix[57], pub[57], rbytes[57], hash[114];
    fg_ed_point b, rp;
    int hn;
    mbedtls_mpi_init(&a);
    mbedtls_mpi_init(&r);
    mbedtls_mpi_init(&k);
    mbedtls_mpi_init(&s);
    fg_edp_init(&b);
    fg_edp_init(&rp);
    MBEDTLS_MPI_CHK(fg_ed_expand(ed, seed, &a, prefix));
    MBEDTLS_MPI_CHK(fg_ed_public(ed, seed, pub));
    MBEDTLS_MPI_CHK(mbedtls_mpi_copy(&b.x, &ed->bx));
    MBEDTLS_MPI_CHK(mbedtls_mpi_copy(&b.y, &ed->by));
    MBEDTLS_MPI_CHK(mbedtls_mpi_lset(&b.z, 1));
    hn = fg_ed_sign_hash(ed, hash, prefix, ed->enc_len, NULL, 0, msg, mlen);
    if (hn < 0) { ret = -1; goto cleanup; }
    MBEDTLS_MPI_CHK(fg_ed_scalar(ed, &r, hash, (size_t) hn));
    MBEDTLS_MPI_CHK(fg_edp_mul(ed, &rp, &r, &b));
    MBEDTLS_MPI_CHK(fg_edp_encode(ed, rbytes, &rp));
    {
        /* k = H(R || A || M) */
        unsigned char *ra = malloc(2 * ed->enc_len);
        if (!ra) { ret = MBEDTLS_ERR_MPI_ALLOC_FAILED; goto cleanup; }
        memcpy(ra, rbytes, ed->enc_len);
        memcpy(ra + ed->enc_len, pub, ed->enc_len);
        hn = fg_ed_sign_hash(ed, hash, ra, 2 * ed->enc_len, NULL, 0, msg, mlen);
        free(ra);
    }
    if (hn < 0) { ret = -1; goto cleanup; }
    MBEDTLS_MPI_CHK(fg_ed_scalar(ed, &k, hash, (size_t) hn));
    MBEDTLS_MPI_CHK(mbedtls_mpi_mul_mpi(&s, &k, &a));
    MBEDTLS_MPI_CHK(mbedtls_mpi_add_mpi(&s, &s, &r));
    MBEDTLS_MPI_CHK(mbedtls_mpi_mod_mpi(&s, &s, &ed->L));
    memcpy(sig, rbytes, ed->enc_len);
    memset(sig + ed->enc_len, 0, ed->enc_len);
    MBEDTLS_MPI_CHK(mbedtls_mpi_write_binary_le(&s, sig + ed->enc_len, ed->enc_len));
cleanup:
    mbedtls_mpi_free(&a);
    mbedtls_mpi_free(&r);
    mbedtls_mpi_free(&k);
    mbedtls_mpi_free(&s);
    fg_edp_free(&b);
    fg_edp_free(&rp);
    return ret;
}

/* 1 valid, 0 not valid (including malformed keys and signatures). */
static int fg_ed_verify(fg_ed *ed, const unsigned char *pub, const unsigned char *msg, size_t mlen, const unsigned char *sig)
{
    int ret, ok = 0, hn;
    mbedtls_mpi s, k;
    fg_ed_point a, rp, b, lhs, rhs, ka;
    unsigned char hash[114];
    mbedtls_mpi lx, ly, rx, ry;
    mbedtls_mpi_init(&s);
    mbedtls_mpi_init(&k);
    mbedtls_mpi_init(&lx);
    mbedtls_mpi_init(&ly);
    mbedtls_mpi_init(&rx);
    mbedtls_mpi_init(&ry);
    fg_edp_init(&a);
    fg_edp_init(&rp);
    fg_edp_init(&b);
    fg_edp_init(&lhs);
    fg_edp_init(&rhs);
    fg_edp_init(&ka);
    if (fg_edp_decode(ed, &a, pub) != 0 || fg_edp_decode(ed, &rp, sig) != 0) goto cleanup;
    MBEDTLS_MPI_CHK(mbedtls_mpi_read_binary_le(&s, sig + ed->enc_len, ed->enc_len));
    if (mbedtls_mpi_cmp_mpi(&s, &ed->L) >= 0) goto cleanup;
    {
        unsigned char *ra = malloc(2 * ed->enc_len);
        if (!ra) goto cleanup;
        memcpy(ra, sig, ed->enc_len);
        memcpy(ra + ed->enc_len, pub, ed->enc_len);
        hn = fg_ed_sign_hash(ed, hash, ra, 2 * ed->enc_len, NULL, 0, msg, mlen);
        free(ra);
    }
    if (hn < 0) goto cleanup;
    MBEDTLS_MPI_CHK(fg_ed_scalar(ed, &k, hash, (size_t) hn));
    MBEDTLS_MPI_CHK(mbedtls_mpi_copy(&b.x, &ed->bx));
    MBEDTLS_MPI_CHK(mbedtls_mpi_copy(&b.y, &ed->by));
    MBEDTLS_MPI_CHK(mbedtls_mpi_lset(&b.z, 1));
    MBEDTLS_MPI_CHK(fg_edp_mul(ed, &lhs, &s, &b));   /* S*B */
    MBEDTLS_MPI_CHK(fg_edp_mul(ed, &ka, &k, &a));    /* k*A */
    MBEDTLS_MPI_CHK(fg_edp_add(ed, &rhs, &rp, &ka)); /* R + k*A */
    MBEDTLS_MPI_CHK(fg_edp_affine(ed, &lx, &ly, &lhs));
    MBEDTLS_MPI_CHK(fg_edp_affine(ed, &rx, &ry, &rhs));
    ok = mbedtls_mpi_cmp_mpi(&lx, &rx) == 0 && mbedtls_mpi_cmp_mpi(&ly, &ry) == 0;
cleanup:
    (void) ret;
    mbedtls_mpi_free(&s);
    mbedtls_mpi_free(&k);
    mbedtls_mpi_free(&lx);
    mbedtls_mpi_free(&ly);
    mbedtls_mpi_free(&rx);
    mbedtls_mpi_free(&ry);
    fg_edp_free(&a);
    fg_edp_free(&rp);
    fg_edp_free(&b);
    fg_edp_free(&lhs);
    fg_edp_free(&rhs);
    fg_edp_free(&ka);
    return ok;
}

static int fg_ed_curve_arg(JSContext *ctx, JSValueConst v)
{
    const char *name = JS_ToCString(ctx, v);
    int is448 = -1;
    if (!name) return -1;
    if (!strcmp(name, "ed25519")) is448 = 0;
    else if (!strcmp(name, "ed448")) is448 = 1;
    JS_FreeCString(ctx, name);
    return is448;
}

/* eddsaPublic(curve, seed) -> public key bytes */
static JSValue fg_eddsa_public(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    int is448 = fg_ed_curve_arg(ctx, argv[0]);
    size_t n = 0;
    uint8_t *seed = JS_GetUint8Array(ctx, &n, argv[1]);
    fg_ed ed;
    unsigned char pub[57];
    int ret;
    if (is448 < 0) return fg_c_throw(ctx, "ERR_CRYPTO_INVALID_CURVE", "Invalid EdDSA curve", 0);
    if (!seed) return JS_EXCEPTION;
    ret = fg_ed_init(&ed, is448);
    if (ret == 0 && n != ed.enc_len) {
        fg_ed_free(&ed);
        return fg_c_throw(ctx, "ERR_CRYPTO_INVALID_KEYLEN", "Invalid key length", 0);
    }
    if (ret == 0) ret = fg_ed_public(&ed, seed, pub);
    if (ret != 0) {
        fg_ed_free(&ed);
        return fg_c_throw(ctx, "ERR_CRYPTO_OPERATION_FAILED", "EdDSA key", ret);
    }
    {
        JSValue v = fg_c_bytes(ctx, pub, ed.enc_len);
        fg_ed_free(&ed);
        return v;
    }
}

/* eddsaSign(curve, seed, message) -> signature */
static JSValue fg_eddsa_sign(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    int is448 = fg_ed_curve_arg(ctx, argv[0]);
    size_t n = 0, mlen = 0;
    uint8_t *seed = JS_GetUint8Array(ctx, &n, argv[1]);
    uint8_t *msg = JS_GetUint8Array(ctx, &mlen, argv[2]);
    fg_ed ed;
    unsigned char sig[114];
    int ret;
    if (is448 < 0) return fg_c_throw(ctx, "ERR_CRYPTO_INVALID_CURVE", "Invalid EdDSA curve", 0);
    if (!seed || !msg) return JS_EXCEPTION;
    ret = fg_ed_init(&ed, is448);
    if (ret == 0 && n != ed.enc_len) {
        fg_ed_free(&ed);
        return fg_c_throw(ctx, "ERR_CRYPTO_INVALID_KEYLEN", "Invalid key length", 0);
    }
    if (ret == 0) ret = fg_ed_sign(&ed, seed, msg, mlen, sig);
    if (ret != 0) {
        fg_ed_free(&ed);
        return fg_c_throw(ctx, "ERR_CRYPTO_OPERATION_FAILED", "EdDSA sign", ret);
    }
    {
        JSValue v = fg_c_bytes(ctx, sig, 2 * ed.enc_len);
        fg_ed_free(&ed);
        return v;
    }
}

/* eddsaVerify(curve, publicKey, message, signature) -> bool */
static JSValue fg_eddsa_verify(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    int is448 = fg_ed_curve_arg(ctx, argv[0]);
    size_t pn = 0, mlen = 0, sn = 0;
    uint8_t *pub = JS_GetUint8Array(ctx, &pn, argv[1]);
    uint8_t *msg = JS_GetUint8Array(ctx, &mlen, argv[2]);
    uint8_t *sig = JS_GetUint8Array(ctx, &sn, argv[3]);
    fg_ed ed;
    int ok = 0;
    if (is448 < 0) return fg_c_throw(ctx, "ERR_CRYPTO_INVALID_CURVE", "Invalid EdDSA curve", 0);
    if (!pub || !msg || !sig) return JS_EXCEPTION;
    if (fg_ed_init(&ed, is448) == 0) {
        if (pn == ed.enc_len && sn == 2 * ed.enc_len) ok = fg_ed_verify(&ed, pub, msg, mlen, sig);
    }
    fg_ed_free(&ed);
    return JS_NewBool(ctx, ok);
}


/* ------------------------------------------------------------------ Zstandard */

static JSValue fg_zstd_error(JSContext *ctx, size_t code)
{
    JSValue err = JS_NewError(ctx);
    JS_SetPropertyStr(ctx, err, "message", JS_NewString(ctx, ZSTD_getErrorName(code)));
    JS_SetPropertyStr(ctx, err, "errno", JS_NewInt32(ctx, (int) ZSTD_getErrorCode(code)));
    JS_SetPropertyStr(ctx, err, "code", JS_NewString(ctx, "ZSTD_error"));
    return JS_Throw(ctx, err);
}

/* zstdCompress(bytes, [[parameter, value], ...]) */
static JSValue fg_zstd_compress(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    size_t n = 0, cap, got;
    uint8_t *in = JS_GetUint8Array(ctx, &n, argv[0]);
    ZSTD_CCtx *cc;
    unsigned char *out;
    JSValue v;
    uint32_t count = 0, i;

    if (!in) return JS_EXCEPTION;
    cc = ZSTD_createCCtx();
    if (!cc) return JS_ThrowOutOfMemory(ctx);
    if (argc > 1 && JS_IsObject(argv[1])) {
        JSValue len = JS_GetPropertyStr(ctx, argv[1], "length");
        JS_ToUint32(ctx, &count, len);
        JS_FreeValue(ctx, len);
        for (i = 0; i < count; i++) {
            JSValue pair = JS_GetPropertyUint32(ctx, argv[1], i);
            JSValue pid = JS_GetPropertyUint32(ctx, pair, 0);
            JSValue pval = JS_GetPropertyUint32(ctx, pair, 1);
            int32_t id = 0, value = 0;
            size_t r;
            JS_ToInt32(ctx, &id, pid);
            JS_ToInt32(ctx, &value, pval);
            JS_FreeValue(ctx, pair);
            JS_FreeValue(ctx, pid);
            JS_FreeValue(ctx, pval);
            r = ZSTD_CCtx_setParameter(cc, (ZSTD_cParameter) id, value);
            if (ZSTD_isError(r)) {
                ZSTD_freeCCtx(cc);
                return fg_c_throw(ctx, "ERR_ZLIB_INITIALIZATION_FAILED", "Setting parameter failed", 0);
            }
        }
    }
    if (argc > 2 && !JS_IsUndefined(argv[2])) {
        double pledged = -1;
        JS_ToFloat64(ctx, &pledged, argv[2]);
        if (pledged >= 0) ZSTD_CCtx_setPledgedSrcSize(cc, (unsigned long long) pledged);
    }
    cap = ZSTD_compressBound(n);
    out = malloc(cap ? cap : 1);
    if (!out) {
        ZSTD_freeCCtx(cc);
        return JS_ThrowOutOfMemory(ctx);
    }
    {
        /* The streaming call, not ZSTD_compress2: that one overwrites the pledged size with the real one. */
        ZSTD_inBuffer input;
        ZSTD_outBuffer output;
        size_t remaining;
        input.src = in;
        input.size = n;
        input.pos = 0;
        output.dst = out;
        output.size = cap;
        output.pos = 0;
        remaining = 0;
        /* Feed the input first: a single call with ZSTD_e_end takes the real size as the pledged one. */
        while (input.pos < input.size) {
            remaining = ZSTD_compressStream2(cc, &output, &input, ZSTD_e_continue);
            if (ZSTD_isError(remaining) || output.pos == output.size) break;
        }
        while (!ZSTD_isError(remaining)) {
            remaining = ZSTD_compressStream2(cc, &output, &input, ZSTD_e_end);
            if (remaining == 0 || output.pos == output.size) break;
        }
        got = ZSTD_isError(remaining) ? remaining : output.pos;
    }
    ZSTD_freeCCtx(cc);
    if (ZSTD_isError(got)) {
        free(out);
        return fg_zstd_error(ctx, got);
    }
    v = fg_c_bytes(ctx, out, got);
    free(out);
    return v;
}

/* zstdDecompress(bytes, maxOutputLength, windowLogMax): every frame in the input, one after another. */
static JSValue fg_zstd_decompress(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    size_t n = 0, cap, used = 0;
    uint8_t *in = JS_GetUint8Array(ctx, &n, argv[0]);
    double max_out = 0;
    int32_t window_log = 0;
    ZSTD_DCtx *dc;
    ZSTD_inBuffer input;
    unsigned char *out;
    size_t last = 0;
    JSValue v;

    if (!in) return JS_EXCEPTION;
    if (argc > 1 && !JS_IsUndefined(argv[1])) JS_ToFloat64(ctx, &max_out, argv[1]);
    if (argc > 2 && !JS_IsUndefined(argv[2])) JS_ToInt32(ctx, &window_log, argv[2]);
    dc = ZSTD_createDCtx();
    if (!dc) return JS_ThrowOutOfMemory(ctx);
    if (window_log > 0) ZSTD_DCtx_setParameter(dc, ZSTD_d_windowLogMax, window_log);
    cap = n * 4 + 4096;
    out = malloc(cap);
    if (!out) {
        ZSTD_freeDCtx(dc);
        return JS_ThrowOutOfMemory(ctx);
    }
    input.src = in;
    input.size = n;
    input.pos = 0;
    while (input.pos < input.size) {
        ZSTD_outBuffer output;
        output.dst = out;
        output.size = cap;
        output.pos = used;
        last = ZSTD_decompressStream(dc, &output, &input);
        used = output.pos;
        if (ZSTD_isError(last)) {
            free(out);
            ZSTD_freeDCtx(dc);
            return fg_zstd_error(ctx, last);
        }
        if (max_out > 0 && (double) used > max_out) {
            free(out);
            ZSTD_freeDCtx(dc);
            return fg_c_throw(ctx, "ERR_BUFFER_TOO_LARGE", "Cannot create a Buffer larger than the maxOutputLength", 0);
        }
        if (last == 0) {
            break; /* one frame: what follows it is not read, as Node does */
        }
        if (used == cap) {
            unsigned char *bigger = realloc(out, cap * 2);
            if (!bigger) {
                free(out);
                ZSTD_freeDCtx(dc);
                return JS_ThrowOutOfMemory(ctx);
            }
            out = bigger;
            cap *= 2;
        }
    }
    ZSTD_freeDCtx(dc);
    if (last != 0 || n == 0) {
        /* The input ended inside a frame. */
        JSValue err = JS_NewError(ctx);
        free(out);
        JS_SetPropertyStr(ctx, err, "message", JS_NewString(ctx, "unexpected end of file"));
        JS_SetPropertyStr(ctx, err, "code", JS_NewString(ctx, "Z_BUF_ERROR"));
        JS_SetPropertyStr(ctx, err, "errno", JS_NewInt32(ctx, -5));
        return JS_Throw(ctx, err);
    }
    v = fg_c_bytes(ctx, out, used);
    free(out);
    return v;
}


/* ------------------------------------------------------------------ incremental ciphers */

#define FG_MAX_CIPHERS 256

typedef struct {
    int in_use, encrypt, aead, ecb, padding;
    size_t bs, tag_len;
    mbedtls_cipher_context_t ctx;
    unsigned char hold[16];
    size_t hold_len;
    unsigned char tag[16];
    int have_tag;
} fg_cs;

static fg_cs fg_ciphers[FG_MAX_CIPHERS];

static fg_cs *fg_cs_get(JSContext *ctx, JSValueConst v)
{
    int32_t id;
    if (JS_ToInt32(ctx, &id, v)) return NULL;
    if (id < 0 || id >= FG_MAX_CIPHERS || !fg_ciphers[id].in_use) {
        JS_ThrowInternalError(ctx, "cipher is not open");
        return NULL;
    }
    return &fg_ciphers[id];
}

static JSValue fg_bad_decrypt(JSContext *ctx)
{
    return fg_c_throw(ctx, "ERR_OSSL_BAD_DECRYPT", "error:1C800064:Provider routines::bad decrypt", 0);
}

static JSValue fg_wrong_block(JSContext *ctx)
{
    return fg_c_throw(ctx, "ERR_OSSL_WRONG_FINAL_BLOCK_LENGTH", "error:1C80006B:Provider routines::wrong final block length", 0);
}

/* cipherOpen(encrypt, name, key, iv, padding, tagLength) -> id */
static JSValue fg_cipher_open(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    int encrypt = JS_ToBool(ctx, argv[0]);
    const char *name = JS_ToCString(ctx, argv[1]);
    size_t klen = 0, ivlen = 0, i;
    uint8_t *key, *iv;
    char upper[64];
    const mbedtls_cipher_info_t *info;
    int32_t tag_len = 16, id = -1;
    int padding = argc > 4 ? JS_ToBool(ctx, argv[4]) : 1, ret;
    fg_cs *cs;
    mbedtls_cipher_mode_t mode;

    if (!name) return JS_EXCEPTION;
    for (i = 0; name[i] && i < sizeof(upper) - 1; i++) upper[i] = (char) ((name[i] >= 'a' && name[i] <= 'z') ? name[i] - 32 : name[i]);
    upper[i] = 0;
    JS_FreeCString(ctx, name);
    key = JS_GetUint8Array(ctx, &klen, argv[2]);
    iv = JS_GetUint8Array(ctx, &ivlen, argv[3]);
    if (!key || !iv) return JS_EXCEPTION;
    if (argc > 5) JS_ToInt32(ctx, &tag_len, argv[5]);
    info = mbedtls_cipher_info_from_string(upper);
    if (!info) return fg_c_throw(ctx, "ERR_CRYPTO_UNKNOWN_CIPHER", "Unknown cipher", 0);
    if (mbedtls_cipher_info_get_key_bitlen(info) != klen * 8) return fg_c_throw(ctx, "ERR_CRYPTO_INVALID_KEYLEN", "Invalid key length", 0);
    for (i = 0; i < FG_MAX_CIPHERS; i++) {
        if (!fg_ciphers[i].in_use) {
            id = (int32_t) i;
            break;
        }
    }
    if (id < 0) return JS_ThrowInternalError(ctx, "too many open ciphers");
    cs = &fg_ciphers[id];
    memset(cs, 0, sizeof(*cs));
    mode = mbedtls_cipher_info_get_mode(info);
    cs->encrypt = encrypt;
    cs->padding = padding;
    cs->bs = mbedtls_cipher_info_get_block_size(info);
    cs->ecb = mode == MBEDTLS_MODE_ECB;
    cs->aead = mode == MBEDTLS_MODE_GCM || mbedtls_cipher_info_get_type(info) == MBEDTLS_CIPHER_CHACHA20_POLY1305;
    cs->tag_len = (size_t) tag_len;
    mbedtls_cipher_init(&cs->ctx);
    ret = mbedtls_cipher_setup(&cs->ctx, info);
    if (ret == 0) ret = mbedtls_cipher_setkey(&cs->ctx, key, (int) (klen * 8), encrypt ? MBEDTLS_ENCRYPT : MBEDTLS_DECRYPT);
    if (ret == 0 && mode == MBEDTLS_MODE_CBC) ret = mbedtls_cipher_set_padding_mode(&cs->ctx, padding ? MBEDTLS_PADDING_PKCS7 : MBEDTLS_PADDING_NONE);
    if (ret == 0 && !cs->ecb) ret = mbedtls_cipher_set_iv(&cs->ctx, iv, ivlen);
    if (ret == 0 && !cs->ecb) ret = mbedtls_cipher_reset(&cs->ctx);
    if (ret != 0) {
        mbedtls_cipher_free(&cs->ctx);
        memset(cs, 0, sizeof(*cs));
        return fg_c_throw(ctx, "ERR_CRYPTO_INVALID_IV", "Invalid initialization vector", ret);
    }
    cs->in_use = 1;
    return JS_NewInt32(ctx, id);
}

/* cipherAad(id, bytes): additional data of an AEAD cipher, before any update */
static JSValue fg_cipher_aad(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    fg_cs *cs = fg_cs_get(ctx, argv[0]);
    size_t n = 0;
    uint8_t *aad;
    int ret;
    if (!cs) return JS_EXCEPTION;
    aad = JS_GetUint8Array(ctx, &n, argv[1]);
    if (!aad) return JS_EXCEPTION;
    ret = mbedtls_cipher_update_ad(&cs->ctx, aad, n);
    if (ret != 0) return fg_c_throw(ctx, "ERR_CRYPTO_INVALID_STATE", "Unsupported state", ret);
    return JS_UNDEFINED;
}

/* cipherTag(id, bytes): the tag a decrypting AEAD cipher must find */
static JSValue fg_cipher_tag(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    fg_cs *cs = fg_cs_get(ctx, argv[0]);
    size_t n = 0;
    uint8_t *tag;
    if (!cs) return JS_EXCEPTION;
    tag = JS_GetUint8Array(ctx, &n, argv[1]);
    if (!tag) return JS_EXCEPTION;
    if (n > 16) n = 16;
    memcpy(cs->tag, tag, n);
    cs->tag_len = n;
    cs->have_tag = 1;
    return JS_UNDEFINED;
}

/* cipherUpdate(id, bytes) -> the output available so far */
static JSValue fg_cipher_update(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    fg_cs *cs = fg_cs_get(ctx, argv[0]);
    size_t n = 0, olen = 0, produced = 0;
    uint8_t *data;
    unsigned char *out;
    int ret = 0;
    JSValue v;
    if (!cs) return JS_EXCEPTION;
    data = JS_GetUint8Array(ctx, &n, argv[1]);
    if (!data) return JS_EXCEPTION;
    out = malloc(n + 64);
    if (!out) return JS_ThrowOutOfMemory(ctx);
    if (cs->ecb) {
        size_t off = 0;
        if (cs->hold_len == cs->bs && n > 0) {
            /* The block held back is not the last one after all. */
            ret = mbedtls_cipher_update(&cs->ctx, cs->hold, cs->bs, out, &olen);
            produced = olen;
            cs->hold_len = 0;
        }
        while (ret == 0 && off < n) {
            size_t take = cs->bs - cs->hold_len;
            if (take > n - off) take = n - off;
            memcpy(cs->hold + cs->hold_len, data + off, take);
            cs->hold_len += take;
            off += take;
            if (cs->hold_len == cs->bs) {
                /* A decrypting cipher with padding keeps the last block back until it knows it is the last. */
                if (!cs->encrypt && cs->padding && off == n) break;
                ret = mbedtls_cipher_update(&cs->ctx, cs->hold, cs->bs, out + produced, &olen);
                if (ret != 0) break;
                produced += olen;
                cs->hold_len = 0;
            }
        }
    } else {
        ret = mbedtls_cipher_update(&cs->ctx, data, n, out, &olen);
        produced = olen;
    }
    if (ret != 0) {
        free(out);
        return fg_c_throw(ctx, "ERR_CRYPTO_OPERATION_FAILED", "cipher update", ret);
    }
    v = fg_c_bytes(ctx, out, produced);
    free(out);
    return v;
}

/* cipherFinal(id) -> the last output; an encrypting AEAD cipher returns { data, tag } */
static JSValue fg_cipher_final(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    fg_cs *cs = fg_cs_get(ctx, argv[0]);
    unsigned char out[64];
    size_t olen = 0;
    int ret;
    JSValue result, data;
    if (!cs) return JS_EXCEPTION;
    if (cs->ecb) {
        if (cs->encrypt) {
            size_t pad;
            if (!cs->padding) {
                if (cs->hold_len != 0) return fg_wrong_block(ctx);
                return fg_c_bytes(ctx, out, 0);
            }
            pad = cs->bs - cs->hold_len;
            memset(cs->hold + cs->hold_len, (int) pad, pad);
            ret = mbedtls_cipher_update(&cs->ctx, cs->hold, cs->bs, out, &olen);
            cs->hold_len = 0;
            if (ret != 0) return fg_c_throw(ctx, "ERR_CRYPTO_OPERATION_FAILED", "cipher final", ret);
            return fg_c_bytes(ctx, out, olen);
        }
        if (cs->padding) {
            unsigned char block[16];
            size_t pad, k;
            if (cs->hold_len != cs->bs) return cs->hold_len == 0 ? fg_bad_decrypt(ctx) : fg_wrong_block(ctx);
            ret = mbedtls_cipher_update(&cs->ctx, cs->hold, cs->bs, block, &olen);
            if (ret != 0) return fg_bad_decrypt(ctx);
            pad = block[cs->bs - 1];
            if (pad == 0 || pad > cs->bs) return fg_bad_decrypt(ctx);
            for (k = 0; k < pad; k++) {
                if (block[cs->bs - 1 - k] != pad) return fg_bad_decrypt(ctx);
            }
            return fg_c_bytes(ctx, block, cs->bs - pad);
        }
        if (cs->hold_len != 0) return fg_wrong_block(ctx);
        return fg_c_bytes(ctx, out, 0);
    }
    ret = mbedtls_cipher_finish(&cs->ctx, out, &olen);
    if (ret != 0) {
        if (ret == MBEDTLS_ERR_CIPHER_FULL_BLOCK_EXPECTED) return fg_wrong_block(ctx);
        if (ret == MBEDTLS_ERR_CIPHER_INVALID_PADDING) return fg_bad_decrypt(ctx);
        return fg_c_throw(ctx, "ERR_CRYPTO_OPERATION_FAILED", "cipher final", ret);
    }
    data = fg_c_bytes(ctx, out, olen);
    if (cs->aead) {
        if (cs->encrypt) {
            unsigned char tag[16];
            ret = mbedtls_cipher_write_tag(&cs->ctx, tag, cs->tag_len);
            if (ret != 0) {
                JS_FreeValue(ctx, data);
                return fg_c_throw(ctx, "ERR_CRYPTO_OPERATION_FAILED", "cipher tag", ret);
            }
            result = JS_NewObject(ctx);
            JS_SetPropertyStr(ctx, result, "data", data);
            JS_SetPropertyStr(ctx, result, "tag", fg_c_bytes(ctx, tag, cs->tag_len));
            return result;
        }
        if (!cs->have_tag || mbedtls_cipher_check_tag(&cs->ctx, cs->tag, cs->tag_len) != 0) {
            JS_FreeValue(ctx, data);
            return fg_c_throw(ctx, "ERR_CRYPTO_INVALID_STATE", "Unsupported state or unable to authenticate data", 0);
        }
    }
    return data;
}

static JSValue fg_cipher_close(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    int32_t id;
    if (JS_ToInt32(ctx, &id, argv[0])) return JS_EXCEPTION;
    if (id >= 0 && id < FG_MAX_CIPHERS && fg_ciphers[id].in_use) {
        mbedtls_cipher_free(&fg_ciphers[id].ctx);
        memset(&fg_ciphers[id], 0, sizeof(fg_ciphers[id]));
    }
    return JS_UNDEFINED;
}

/* kwWrap(kek, data, padded) / kwUnwrap(kek, data, padded): RFC 3394 and RFC 5649 AES key wrap */
static JSValue fg_kw(JSContext *ctx, int argc, JSValueConst *argv, int wrap)
{
    size_t klen = 0, dlen = 0, olen = 0;
    uint8_t *kek = JS_GetUint8Array(ctx, &klen, argv[0]);
    uint8_t *data = JS_GetUint8Array(ctx, &dlen, argv[1]);
    int padded = argc > 2 && JS_ToBool(ctx, argv[2]);
    mbedtls_nist_kw_context kw;
    unsigned char *out;
    int ret;
    JSValue v;
    if (!kek || !data) return JS_EXCEPTION;
    mbedtls_nist_kw_init(&kw);
    ret = mbedtls_nist_kw_setkey(&kw, MBEDTLS_CIPHER_ID_AES, kek, (unsigned int) (klen * 8), wrap);
    if (ret != 0) {
        mbedtls_nist_kw_free(&kw);
        return fg_c_throw(ctx, "ERR_CRYPTO_INVALID_KEYLEN", "Invalid key length", ret);
    }
    out = malloc(dlen + 16);
    if (!out) {
        mbedtls_nist_kw_free(&kw);
        return JS_ThrowOutOfMemory(ctx);
    }
    if (wrap) {
        ret = mbedtls_nist_kw_wrap(&kw, padded ? MBEDTLS_KW_MODE_KWP : MBEDTLS_KW_MODE_KW, data, dlen, out, &olen, dlen + 16);
    } else {
        ret = mbedtls_nist_kw_unwrap(&kw, padded ? MBEDTLS_KW_MODE_KWP : MBEDTLS_KW_MODE_KW, data, dlen, out, &olen, dlen + 16);
    }
    mbedtls_nist_kw_free(&kw);
    if (ret != 0) {
        free(out);
        return fg_c_throw(ctx, wrap ? "ERR_CRYPTO_OPERATION_FAILED" : "ERR_OSSL_BAD_DECRYPT", wrap ? "key wrap failed" : "error:1C800064:Provider routines::bad decrypt", 0);
    }
    v = fg_c_bytes(ctx, out, olen);
    free(out);
    return v;
}

static JSValue fg_kw_wrap(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    return fg_kw(ctx, argc, argv, 1);
}

static JSValue fg_kw_unwrap(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    return fg_kw(ctx, argc, argv, 0);
}

/* modPow(base, exp, mod) -> big-endian bytes of base^exp mod mod (Diffie-Hellman) */
static JSValue fg_mod_pow(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    size_t bn = 0, en = 0, mn = 0;
    uint8_t *b = JS_GetUint8Array(ctx, &bn, argv[0]);
    uint8_t *e = JS_GetUint8Array(ctx, &en, argv[1]);
    uint8_t *m = JS_GetUint8Array(ctx, &mn, argv[2]);
    mbedtls_mpi base, exp, mod, res;
    int ret;
    JSValue v;

    if (!b || !e || !m) return JS_EXCEPTION;
    mbedtls_mpi_init(&base);
    mbedtls_mpi_init(&exp);
    mbedtls_mpi_init(&mod);
    mbedtls_mpi_init(&res);
    ret = mbedtls_mpi_read_binary(&base, b, bn);
    if (ret == 0) ret = mbedtls_mpi_read_binary(&exp, e, en);
    if (ret == 0) ret = mbedtls_mpi_read_binary(&mod, m, mn);
    if (ret == 0 && mbedtls_mpi_cmp_int(&mod, 1) <= 0) ret = MBEDTLS_ERR_MPI_BAD_INPUT_DATA;
    if (ret == 0) ret = mbedtls_mpi_exp_mod(&res, &base, &exp, &mod, NULL);
    if (ret != 0) {
        mbedtls_mpi_free(&base);
        mbedtls_mpi_free(&exp);
        mbedtls_mpi_free(&mod);
        mbedtls_mpi_free(&res);
        return fg_c_throw(ctx, "ERR_CRYPTO_OPERATION_FAILED", "modular exponentiation", ret);
    }
    v = fg_c_mpi(ctx, &res);
    mbedtls_mpi_free(&base);
    mbedtls_mpi_free(&exp);
    mbedtls_mpi_free(&mod);
    mbedtls_mpi_free(&res);
    return v;
}

/* caBundle() -> the compiled-in trust store as PEM */
static JSValue fg_ca_bundle(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    return JS_NewString(ctx, graak_ca_bundle);
}


/* ---- compression functions the JavaScript hashes call per block (BLAKE2b, BLAKE2s, Argon2, Keccak-f) ---- */

/* The bytes of a typed array of any element type, or NULL with an exception thrown. */
static uint8_t *fg_typed_bytes(JSContext *ctx, JSValueConst v, size_t *len)
{
    size_t off, blen, bpe, total;
    JSValue buf = JS_GetTypedArrayBuffer(ctx, v, &off, &blen, &bpe);
    uint8_t *base;
    if (JS_IsException(buf)) return NULL;
    base = JS_GetArrayBuffer(ctx, &total, buf);
    JS_FreeValue(ctx, buf);
    if (!base) return NULL;
    *len = blen;
    return base + off;
}

static const uint8_t fg_blake2_sigma[10][16] = {
    {0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15}, {14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3},
    {11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4}, {7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8},
    {9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13}, {2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9},
    {12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11}, {13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10},
    {6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5}, {10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0},
};
static const uint64_t fg_blake2b_iv[8] = {
    0x6a09e667f3bcc908ULL, 0xbb67ae8584caa73bULL, 0x3c6ef372fe94f82bULL, 0xa54ff53a5f1d36f1ULL,
    0x510e527fade682d1ULL, 0x9b05688c2b3e6c1fULL, 0x1f83d9abfb41bd6bULL, 0x5be0cd19137e2179ULL,
};
static const uint32_t fg_blake2s_iv[8] = {
    0x6a09e667u, 0xbb67ae85u, 0x3c6ef372u, 0xa54ff53au, 0x510e527fu, 0x9b05688cu, 0x1f83d9abu, 0x5be0cd19u,
};

static uint64_t fg_ror64(uint64_t x, int n)
{
    return (x >> n) | (x << (64 - n));
}
static uint32_t fg_ror32(uint32_t x, int n)
{
    return (x >> n) | (x << (32 - n));
}

#define FG_B2B_G(a, b, c, d, x, y)                                                                                     \
    do {                                                                                                               \
        v[a] = v[a] + v[b] + (x);                                                                                      \
        v[d] = fg_ror64(v[d] ^ v[a], 32);                                                                              \
        v[c] = v[c] + v[d];                                                                                            \
        v[b] = fg_ror64(v[b] ^ v[c], 24);                                                                              \
        v[a] = v[a] + v[b] + (y);                                                                                      \
        v[d] = fg_ror64(v[d] ^ v[a], 16);                                                                              \
        v[c] = v[c] + v[d];                                                                                            \
        v[b] = fg_ror64(v[b] ^ v[c], 63);                                                                              \
    } while (0)

/* blake2bCompress(h: Uint32Array(16), block: Uint8Array, offset, tLo, tHi, last) */
static JSValue fg_blake2b_compress(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    size_t hn, bn;
    uint8_t *hb, *bb;
    uint32_t off, tlo, thi;
    int last, i, r;
    uint64_t h[8], m[16], v[16], t;
    if (argc < 6) return JS_ThrowTypeError(ctx, "blake2bCompress(h, block, offset, tLo, tHi, last)");
    hb = fg_typed_bytes(ctx, argv[0], &hn);
    bb = JS_GetUint8Array(ctx, &bn, argv[1]);
    if (!hb || !bb) return JS_EXCEPTION;
    if (JS_ToUint32(ctx, &off, argv[2]) || JS_ToUint32(ctx, &tlo, argv[3]) || JS_ToUint32(ctx, &thi, argv[4])) return JS_EXCEPTION;
    last = JS_ToBool(ctx, argv[5]);
    if (hn < 64 || (size_t) off + 128 > bn) return JS_ThrowRangeError(ctx, "blake2bCompress: out of range");
    for (i = 0; i < 8; i++) {
        uint64_t lo = 0, hi = 0;
        int k;
        for (k = 3; k >= 0; k--) {
            lo = (lo << 8) | hb[i * 8 + k];
            hi = (hi << 8) | hb[i * 8 + 4 + k];
        }
        h[i] = lo | (hi << 32);
    }
    for (i = 0; i < 16; i++) {
        uint64_t x = 0;
        int k;
        for (k = 7; k >= 0; k--) x = (x << 8) | bb[off + i * 8 + k];
        m[i] = x;
    }
    t = (uint64_t) tlo | ((uint64_t) thi << 32);
    for (i = 0; i < 8; i++) {
        v[i] = h[i];
        v[i + 8] = fg_blake2b_iv[i];
    }
    v[12] ^= t;
    if (last) v[14] = ~v[14];
    for (r = 0; r < 12; r++) {
        const uint8_t *s = fg_blake2_sigma[r % 10];
        FG_B2B_G(0, 4, 8, 12, m[s[0]], m[s[1]]);
        FG_B2B_G(1, 5, 9, 13, m[s[2]], m[s[3]]);
        FG_B2B_G(2, 6, 10, 14, m[s[4]], m[s[5]]);
        FG_B2B_G(3, 7, 11, 15, m[s[6]], m[s[7]]);
        FG_B2B_G(0, 5, 10, 15, m[s[8]], m[s[9]]);
        FG_B2B_G(1, 6, 11, 12, m[s[10]], m[s[11]]);
        FG_B2B_G(2, 7, 8, 13, m[s[12]], m[s[13]]);
        FG_B2B_G(3, 4, 9, 14, m[s[14]], m[s[15]]);
    }
    for (i = 0; i < 8; i++) {
        uint64_t x = h[i] ^ v[i] ^ v[i + 8];
        int k;
        for (k = 0; k < 4; k++) {
            hb[i * 8 + k] = (uint8_t) (x >> (8 * k));
            hb[i * 8 + 4 + k] = (uint8_t) (x >> (32 + 8 * k));
        }
    }
    return JS_UNDEFINED;
}

#define FG_B2S_G(a, b, c, d, x, y)                                                                                     \
    do {                                                                                                               \
        v[a] = v[a] + v[b] + (x);                                                                                      \
        v[d] = fg_ror32(v[d] ^ v[a], 16);                                                                              \
        v[c] = v[c] + v[d];                                                                                            \
        v[b] = fg_ror32(v[b] ^ v[c], 12);                                                                              \
        v[a] = v[a] + v[b] + (y);                                                                                      \
        v[d] = fg_ror32(v[d] ^ v[a], 8);                                                                               \
        v[c] = v[c] + v[d];                                                                                            \
        v[b] = fg_ror32(v[b] ^ v[c], 7);                                                                               \
    } while (0)

/* blake2sCompress(h: Uint32Array(8), block: Uint8Array, offset, tLo, tHi, last) */
static JSValue fg_blake2s_compress(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    size_t hn, bn;
    uint8_t *hb, *bb;
    uint32_t off, tlo, thi, h[8], m[16], v[16];
    int last, i, r;
    if (argc < 6) return JS_ThrowTypeError(ctx, "blake2sCompress(h, block, offset, tLo, tHi, last)");
    hb = fg_typed_bytes(ctx, argv[0], &hn);
    bb = JS_GetUint8Array(ctx, &bn, argv[1]);
    if (!hb || !bb) return JS_EXCEPTION;
    if (JS_ToUint32(ctx, &off, argv[2]) || JS_ToUint32(ctx, &tlo, argv[3]) || JS_ToUint32(ctx, &thi, argv[4])) return JS_EXCEPTION;
    last = JS_ToBool(ctx, argv[5]);
    if (hn < 32 || (size_t) off + 64 > bn) return JS_ThrowRangeError(ctx, "blake2sCompress: out of range");
    for (i = 0; i < 8; i++) h[i] = (uint32_t) hb[i * 4] | ((uint32_t) hb[i * 4 + 1] << 8) | ((uint32_t) hb[i * 4 + 2] << 16) | ((uint32_t) hb[i * 4 + 3] << 24);
    for (i = 0; i < 16; i++) {
        const uint8_t *p = bb + off + i * 4;
        m[i] = (uint32_t) p[0] | ((uint32_t) p[1] << 8) | ((uint32_t) p[2] << 16) | ((uint32_t) p[3] << 24);
    }
    for (i = 0; i < 8; i++) {
        v[i] = h[i];
        v[i + 8] = fg_blake2s_iv[i];
    }
    v[12] ^= tlo;
    v[13] ^= thi;
    if (last) v[14] = ~v[14];
    for (r = 0; r < 10; r++) {
        const uint8_t *s = fg_blake2_sigma[r];
        FG_B2S_G(0, 4, 8, 12, m[s[0]], m[s[1]]);
        FG_B2S_G(1, 5, 9, 13, m[s[2]], m[s[3]]);
        FG_B2S_G(2, 6, 10, 14, m[s[4]], m[s[5]]);
        FG_B2S_G(3, 7, 11, 15, m[s[6]], m[s[7]]);
        FG_B2S_G(0, 5, 10, 15, m[s[8]], m[s[9]]);
        FG_B2S_G(1, 6, 11, 12, m[s[10]], m[s[11]]);
        FG_B2S_G(2, 7, 8, 13, m[s[12]], m[s[13]]);
        FG_B2S_G(3, 4, 9, 14, m[s[14]], m[s[15]]);
    }
    for (i = 0; i < 8; i++) {
        uint32_t x = h[i] ^ v[i] ^ v[i + 8];
        hb[i * 4] = (uint8_t) x;
        hb[i * 4 + 1] = (uint8_t) (x >> 8);
        hb[i * 4 + 2] = (uint8_t) (x >> 16);
        hb[i * 4 + 3] = (uint8_t) (x >> 24);
    }
    return JS_UNDEFINED;
}

#define FG_A2_GB(a, b, c, d)                                                                                           \
    do {                                                                                                               \
        a = a + b + 2 * (uint64_t) (uint32_t) a * (uint32_t) b;                                                        \
        d = fg_ror64(d ^ a, 32);                                                                                       \
        c = c + d + 2 * (uint64_t) (uint32_t) c * (uint32_t) d;                                                        \
        b = fg_ror64(b ^ c, 24);                                                                                       \
        a = a + b + 2 * (uint64_t) (uint32_t) a * (uint32_t) b;                                                        \
        d = fg_ror64(d ^ a, 16);                                                                                       \
        c = c + d + 2 * (uint64_t) (uint32_t) c * (uint32_t) d;                                                        \
        b = fg_ror64(b ^ c, 63);                                                                                       \
    } while (0)

static void fg_a2_p(uint64_t *v0, uint64_t *v1, uint64_t *v2, uint64_t *v3, uint64_t *v4, uint64_t *v5, uint64_t *v6, uint64_t *v7,
                    uint64_t *v8, uint64_t *v9, uint64_t *v10, uint64_t *v11, uint64_t *v12, uint64_t *v13, uint64_t *v14,
                    uint64_t *v15)
{
    FG_A2_GB(*v0, *v4, *v8, *v12);
    FG_A2_GB(*v1, *v5, *v9, *v13);
    FG_A2_GB(*v2, *v6, *v10, *v14);
    FG_A2_GB(*v3, *v7, *v11, *v15);
    FG_A2_GB(*v0, *v5, *v10, *v15);
    FG_A2_GB(*v1, *v6, *v11, *v12);
    FG_A2_GB(*v2, *v7, *v8, *v13);
    FG_A2_GB(*v3, *v4, *v9, *v14);
}

static uint64_t fg_ld64(const uint8_t *p)
{
    uint64_t x = 0;
    int k;
    for (k = 7; k >= 0; k--) x = (x << 8) | p[k];
    return x;
}
static void fg_st64(uint8_t *p, uint64_t x)
{
    int k;
    for (k = 0; k < 8; k++) p[k] = (uint8_t) (x >> (8 * k));
}

/* argon2Fill(prev, prevOff, ref, refOff, next, nextOff, withXor): the Argon2 block compression G on Uint32Array blocks of 256 words. */
static JSValue fg_argon2_fill(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    size_t pn, rn, nn;
    uint8_t *pb, *rb, *nb;
    uint32_t po, ro, no;
    int withxor, i;
    uint64_t r[128], z[128];
    if (argc < 7) return JS_ThrowTypeError(ctx, "argon2Fill(prev, prevOff, ref, refOff, next, nextOff, withXor)");
    pb = fg_typed_bytes(ctx, argv[0], &pn);
    rb = fg_typed_bytes(ctx, argv[2], &rn);
    nb = fg_typed_bytes(ctx, argv[4], &nn);
    if (!pb || !rb || !nb) return JS_EXCEPTION;
    if (JS_ToUint32(ctx, &po, argv[1]) || JS_ToUint32(ctx, &ro, argv[3]) || JS_ToUint32(ctx, &no, argv[5])) return JS_EXCEPTION;
    withxor = JS_ToBool(ctx, argv[6]);
    if (((size_t) po + 256) * 4 > pn || ((size_t) ro + 256) * 4 > rn || ((size_t) no + 256) * 4 > nn) {
        return JS_ThrowRangeError(ctx, "argon2Fill: out of range");
    }
    for (i = 0; i < 128; i++) {
        r[i] = fg_ld64(pb + (size_t) po * 4 + i * 8) ^ fg_ld64(rb + (size_t) ro * 4 + i * 8);
        z[i] = r[i];
    }
    for (i = 0; i < 8; i++) {
        uint64_t *q = z + 16 * i;
        fg_a2_p(q + 0, q + 1, q + 2, q + 3, q + 4, q + 5, q + 6, q + 7, q + 8, q + 9, q + 10, q + 11, q + 12, q + 13, q + 14, q + 15);
    }
    for (i = 0; i < 8; i++) {
        uint64_t *q = z + 2 * i;
        fg_a2_p(q + 0, q + 1, q + 16, q + 17, q + 32, q + 33, q + 48, q + 49, q + 64, q + 65, q + 80, q + 81, q + 96, q + 97, q + 112,
                q + 113);
    }
    for (i = 0; i < 128; i++) {
        uint64_t x = r[i] ^ z[i];
        uint8_t *dst = nb + (size_t) no * 4 + i * 8;
        if (withxor) x ^= fg_ld64(dst);
        fg_st64(dst, x);
    }
    return JS_UNDEFINED;
}

/* keccakPermute(hi: Int32Array(25), lo: Int32Array(25), rounds): the last `rounds` rounds of Keccak-f[1600] on the split state. */
static JSValue fg_keccak_permute(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    size_t hn, ln;
    uint8_t *hb, *lb;
    int32_t rounds;
    uint64_t st[25];
    int i;
    if (argc < 3) return JS_ThrowTypeError(ctx, "keccakPermute(hi, lo, rounds)");
    hb = fg_typed_bytes(ctx, argv[0], &hn);
    lb = fg_typed_bytes(ctx, argv[1], &ln);
    if (!hb || !lb) return JS_EXCEPTION;
    if (JS_ToInt32(ctx, &rounds, argv[2])) return JS_EXCEPTION;
    if (hn < 100 || ln < 100 || rounds < 0 || rounds > 24) return JS_ThrowRangeError(ctx, "keccakPermute: out of range");
    for (i = 0; i < 25; i++) {
        uint32_t h = (uint32_t) hb[i * 4] | ((uint32_t) hb[i * 4 + 1] << 8) | ((uint32_t) hb[i * 4 + 2] << 16) | ((uint32_t) hb[i * 4 + 3] << 24);
        uint32_t l = (uint32_t) lb[i * 4] | ((uint32_t) lb[i * 4 + 1] << 8) | ((uint32_t) lb[i * 4 + 2] << 16) | ((uint32_t) lb[i * 4 + 3] << 24);
        st[i] = ((uint64_t) h << 32) | l;
    }
    fg_keccak_f_from(st, 24 - rounds);
    for (i = 0; i < 25; i++) {
        uint32_t h = (uint32_t) (st[i] >> 32), l = (uint32_t) st[i];
        int k;
        for (k = 0; k < 4; k++) {
            hb[i * 4 + k] = (uint8_t) (h >> (8 * k));
            lb[i * 4 + k] = (uint8_t) (l >> (8 * k));
        }
    }
    return JS_UNDEFINED;
}

const JSCFunctionListEntry graak_crypto_funcs[] = {
    JS_CFUNC_DEF("brotliCompress", 4, fg_brotli_compress),
    JS_CFUNC_DEF("brotliDecompress", 2, fg_brotli_decompress),
    JS_CFUNC_DEF("x509Info", 1, fg_x509_info),
    JS_CFUNC_DEF("x509CheckIssued", 2, fg_x509_check_issued),
    JS_CFUNC_DEF("keyMatchesCert", 3, fg_key_matches_cert),
    JS_CFUNC_DEF("keyInfo", 3, fg_key_info),
    JS_CFUNC_DEF("generateKey", 3, fg_generate_key),
    JS_CFUNC_DEF("rsaCrypt", 7, fg_rsa_crypt),
    JS_CFUNC_DEF("pkSignEx", 6, fg_pk_sign_ex),
    JS_CFUNC_DEF("pkVerifyEx", 6, fg_pk_verify_ex),
    JS_CFUNC_DEF("pkSignRawEc", 3, fg_pk_sign_raw_ec),
    JS_CFUNC_DEF("pkVerifyRawEc", 3, fg_pk_verify_raw_ec),
    JS_CFUNC_DEF("ecdhGenerate", 2, fg_ecdh_generate),
    JS_CFUNC_DEF("ecdhCompute", 3, fg_ecdh_compute),
    JS_CFUNC_DEF("ecdhConvert", 3, fg_ecdh_convert),
    JS_CFUNC_DEF("genPrime", 2, fg_gen_prime),
    JS_CFUNC_DEF("isPrime", 2, fg_is_prime),
    JS_CFUNC_DEF("modPow", 3, fg_mod_pow),
    JS_CFUNC_DEF("cipherOpen", 6, fg_cipher_open),
    JS_CFUNC_DEF("cipherAad", 2, fg_cipher_aad),
    JS_CFUNC_DEF("cipherTag", 2, fg_cipher_tag),
    JS_CFUNC_DEF("cipherUpdate", 2, fg_cipher_update),
    JS_CFUNC_DEF("cipherFinal", 1, fg_cipher_final),
    JS_CFUNC_DEF("cipherClose", 1, fg_cipher_close),
    JS_CFUNC_DEF("kwWrap", 3, fg_kw_wrap),
    JS_CFUNC_DEF("kwUnwrap", 3, fg_kw_unwrap),
    JS_CFUNC_DEF("zstdCompress", 3, fg_zstd_compress),
    JS_CFUNC_DEF("zstdDecompress", 3, fg_zstd_decompress),
    JS_CFUNC_DEF("keccak", 3, fg_keccak_js),
    JS_CFUNC_DEF("blake2bCompress", 6, fg_blake2b_compress),
    JS_CFUNC_DEF("blake2sCompress", 6, fg_blake2s_compress),
    JS_CFUNC_DEF("argon2Fill", 7, fg_argon2_fill),
    JS_CFUNC_DEF("keccakPermute", 3, fg_keccak_permute),
    JS_CFUNC_DEF("eddsaPublic", 2, fg_eddsa_public),
    JS_CFUNC_DEF("eddsaSign", 3, fg_eddsa_sign),
    JS_CFUNC_DEF("eddsaVerify", 4, fg_eddsa_verify),
    JS_CFUNC_DEF("caBundle", 0, fg_ca_bundle),
};
const size_t graak_crypto_funcs_count = sizeof(graak_crypto_funcs) / sizeof(graak_crypto_funcs[0]);
