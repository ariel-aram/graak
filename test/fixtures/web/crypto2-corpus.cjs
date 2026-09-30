/* Differential corpus: asymmetric crypto (keys, sign/verify, RSA encryption, ECDH, Diffie-Hellman, primes, X509). Prints one line per check. */
const crypto = require("crypto");
const RSA = "-----BEGIN PRIVATE KEY-----\nMIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQDtoOIXmn2FtiV8\nHccsANl50rPNkghBDSw0EWufDg0uX5aGMbGCa155yAANAsPH+KmA9BiUwVVKUHj4\n+ne0IIhks7DXs33Qx2xoCIJqo94WeKmtbpZKPsg1ql6+c3B6Vlpq6av7bbj0aqcZ\nln3qljpc3cP3aHahlseIsSF7EosuBIqpWHlFpmnMk4nX/KMekc24otyFRJfmxAzO\nZtaf3B8E4mgMEiVRrhzx0W4HfxhxnjAkgGhuUln8XUjeUYHvZ3uErQcC6T5wReKN\n8DNxOMFfy35n5UC4e03nFDbGH/G9eTwfqwGukLKmaYnrjBoZHcNjX0/7aGWMzqy/\n71aoLgrjAgMBAAECggEAJ482CdSSpapEzpyCe4/fT0ma3Kk9WIm3MdUzQ8pqEANN\nItADtiuREdhlhxpOZOxqWOkfbSb2alBqo0Bx9yRyBcRoYgXOoe2L3ZHfwZ3AK6Db\ngTTng5AKHUJcqCYTCTrLrgAdZ9ZvXmP2/OqHJyuVUb/Vj6BDckk7X0U7HABiopPq\n0vjCdYp7jaFlac0PID70nmVFo7zFb02CBSvSGr0Y73qDcKbU7gyJ7zMhJxBd7W7D\nZgE1LtYU1PTKpDCbPTtF35Ghncq1ASr6tbS0iAb2R05DHwkz4NxX2hwlHNepmlWU\nUGVb5qqKqdUKiqpX2WhGUy/6JRY5scwpSZvwb1CU0QKBgQD96RBldZQIU0UjAkBV\nvN0cNDOiJ1CRQtC3Zb56q5soZZq8MZ2es0eXggpbuup6jB/K0Db/84ZCBHrSCIhQ\nMJ971xfmQA+4jCa7QkxZgOQIbAx7036p7NsVKzHEeh7GXyrykpmFIJpWmnPTvhN7\nOl9SlHTGCXasEY6nhqVXSx/NCQKBgQDvlYQ2nFPFz6Goo5L33yh3y6R3i5TAERs7\nAPNV+SssR1WOWvAI1MFrz/B8KATuafiLpsGcGXRemhObdHuUvF46eYcNlMRC94bc\nAcQBz3ZCz/1uD65ICHp7jHrC/WfMXNzG2W+F9IdZ+x6dwixLuDSOjr4tILsG+4P2\nWl4y8HC/iwKBgE1xiau4egc0BrFP3XmJGlOg5GK/5QX5QBm/8aIOt0tR+ikOZQnj\nmqFua2RhFWV9WbENYskcaMW4AhIPwivbOLmX+FUlEuZx8NpKtWjTNDoRYpld/5Mq\niAPj4dEQglR08G9+IU8Gi6yAfXWG0wBR5IMWfqtsdYKz9DPKkKGYa0GpAoGAWVwv\nIB9Wr6Ut6rR4ELPPaD8wbNZG+QxoV62XFS4GiFFi++G3PdP9ALViQSy8CiDEb3IX\nLJ3h5ZcaURU1Mti/XJgPY2VlfoTMbCrMbNBwj6L8J5z5qCxhYsuWzjuuB29reU+I\nZTI7ebhMRxMxalyeXb2n+TUIDSaqpaw3DlDX/NkCgYAD237GgkKwz/JrnJ5Gijm+\nxBM2QVxGA+6BLEvKTLQyCVgFb7l5+/2rasvErzoPPjpyg3iBIQvbZV0fzZssRYid\nUpYuH0Vmg08HQ4cNJ4DC9ecqKeUvXIqxrpDzwT9q+Z1FMLUEnU4icmeorKdwRA/6\nCVd9zFt3HqSgPH0ISLZoig==\n-----END PRIVATE KEY-----\n";
const EC = "-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgbD5uAmZNbbBOuh9V\nY/79kfJBTgef+2A9pjaBDt7mPuehRANCAAQO5SjSpZoyOY6xPMjZ0K9evg05CdvZ\n+gLiKWFU0vKB1Ts0rbDzMsdqkjJAJtSZZLxLwSAkQf5wzaKR4CuqfOqr\n-----END PRIVATE KEY-----\n";
const EC384 = "-----BEGIN PRIVATE KEY-----\nMIG2AgEAMBAGByqGSM49AgEGBSuBBAAiBIGeMIGbAgEBBDCRi/tkhbn0x2KIncDl\nXXIOYNaFdTQhv4dcsWV9YkJfAQJIY6P5b7w6KzqdpY/cmOKhZANiAAT47hrqk2JP\nKzb/EDshOWkrZpmPvvrAXxOWEa4N1WaHlqsEQ02zgte0dtJ8TfC1gLRJhvMIardi\nRsAtiO8QCaZXmOflCGUpnLzMu+P85YLI8J9EnB6HIPjg5A18zuRtELA=\n-----END PRIVATE KEY-----\n";
const RSA_ENC = "-----BEGIN ENCRYPTED PRIVATE KEY-----\nMIIFNTBfBgkqhkiG9w0BBQ0wUjAxBgkqhkiG9w0BBQwwJAQQalKzxxfceqCbElVX\nZ6o39gICCAAwDAYIKoZIhvcNAgkFADAdBglghkgBZQMEASoEECAFIW7Y+u3t8lAL\nYZYiMB4EggTQ7yfZn0WKvjgnHQzm4edpkEYVmzYftq0QJQZkG3DP0Nb3iqUEIQIf\njwwcxA2AITVcC6xTPWPmHw/9xDuv/iXJNBwxGXOdXyWJcv2EErWBu6onPANToWg9\nhYP/D/do7gvD1DpeqV4YpKOgUpdaUGz+6RdJVevNmjre6yG2BNTtWelw9f1eDg8x\nuSrdE0z3JfNRuKzautpwm83OR5f+ZeP7lmk9ehVZA6fiH7jjCSCMqiCPWE5bu53v\nPPEqU8xIpIV1emj0b0QU/0YManNG8AKJAeDbeg/1Ob8+fgw3+U4zX4AkKq1L64Ia\nWTt2lGnbkAjO+D36y7QxGYk90bs6X7wJa7tZGaxNtftQmx/pBINFUMeFnWB7N0ax\nWqhaRLt4Ndy0HsVQpTvbfzF0Co8wAKKa08WOln7RhJcdkwmENJc8c0cfr6txIZkq\nVbOM0qmt7ZTqzb2u05fpB8joEW3fIt0b30xjfH6EwKqyQ9UAdzM9IPgpse5rfN+T\nbOb78jFd9Uf9Qhn4NQ9jxooCcMOTjA02JU7P8bxeVAqt+h0OFVY6GAYidt7sM3w7\nLkhfp+xIEzhtousxQ57sAdrEVgP9UOpHgi7p5axVqh1D+smy+zKOhD/pPCj863Zc\npwyerzELqburIletg2lTtU9oI2ZCSFS8GTfVKvWGZ51MjagWieaImoDjRC2eFxbY\nO5PrC6P28IQEP8qiBIl0/t2nmgHO6x5RUh9qfJ2vGyl+qvLZsjVyiFvTTNRVdsHI\nSB2qT9xNAiE+PX6+Ur6ikIVnTrGFtGmQ/JzJ0lQXUEueEHjhYpfwXgMA5+eEeCjx\nO1pmz86gjIE5mh2xjx2fdfRrwa5/QjKnJCuZKFm0X7rw+fZt6duqI+uTyNAJkKx1\nZqBWt4JprCmELvBw1qg5eT0UsRFcSmIShsHAAnWKl8p3dAQXL2mHmTLcuetB6l28\nKEnrvMV5PudmVvdZiqzprb4upTN44IPuqX8bGDT29MkqSEjsTEK+M1CUiwBT7hU8\nOLPPE7y195m8HS3th01Jp3D03hIbp+Fdvz/rstpPfLwri348qmNhZN7WRehOZJ4s\nJrJ9oqgeyFwAJQx63Vo7Q+f6Ap1jhKi2+MErQAfJm1iVBq3Nz9UHUE/gUof7QxZK\nLiQR9lk7qHtb28ELFKR3S4N1jp8C65Eie0ncsTbU6Zi7shVieaCJmDYEYyAu1aHw\nZdF0vDs9haIZEdEsfHMHHVgRwe3EUdLn/dHAcvQOc8K3miuqdjACGW1WIpzU5/OW\nOD2gvPOYhlxNwYZu1ZgQ2G889GBEJmTZhlAanok3eBauJm5E2q+VpC53AFTnP9Zj\negs2ndvuwzdtJdsZk2v0+7gkRtEZO0MuIdhlDC/g8nFsUkxwO45T5O+Wk46SB+iR\nJAk9QJanFte465YvFOiwCKIMtc0l2tCr08ixklfCQ//OqeOZABUuZmzcWUX4X/D5\nAm7VecZQdVEKsN3O/C8zqmBNBt9K1iEEDX1VsqzlwqhRAgTC92qI1tzgjm0g+W6V\n3F7ma0IjuZWTJPerW0DmULS1ZQWq29pZP0Y26pxATdUrNwM06nLBotxdkVPtPN+a\nCJwMr9KNHwjrmOTjw++Mc6Y2jjS/+5lgMa/TnlNiRFZVTjpeHvmIAHM=\n-----END ENCRYPTED PRIVATE KEY-----\n";
const RSA_CERT = "-----BEGIN CERTIFICATE-----\nMIIEIDCCAwigAwIBAgIUZXc4wsQFghqudo40aBMYULbyJB4wDQYJKoZIhvcNAQEL\nBQAwaDELMAkGA1UEBhMCQlIxEjAQBgNVBAgMCVNhbyBQYXVsbzEOMAwGA1UEBwwF\nU2FtcGExEzARBgNVBAoMCkdyYWFrIFRlc3QxCzAJBgNVBAsMAlFBMRMwEQYDVQQD\nDApncmFhay50ZXN0MCAXDTI2MDkyNDE5Mzc1NFoYDzIxMjYwODMxMTkzNzU0WjBo\nMQswCQYDVQQGEwJCUjESMBAGA1UECAwJU2FvIFBhdWxvMQ4wDAYDVQQHDAVTYW1w\nYTETMBEGA1UECgwKR3JhYWsgVGVzdDELMAkGA1UECwwCUUExEzARBgNVBAMMCmdy\nYWFrLnRlc3QwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQDtoOIXmn2F\ntiV8HccsANl50rPNkghBDSw0EWufDg0uX5aGMbGCa155yAANAsPH+KmA9BiUwVVK\nUHj4+ne0IIhks7DXs33Qx2xoCIJqo94WeKmtbpZKPsg1ql6+c3B6Vlpq6av7bbj0\naqcZln3qljpc3cP3aHahlseIsSF7EosuBIqpWHlFpmnMk4nX/KMekc24otyFRJfm\nxAzOZtaf3B8E4mgMEiVRrhzx0W4HfxhxnjAkgGhuUln8XUjeUYHvZ3uErQcC6T5w\nReKN8DNxOMFfy35n5UC4e03nFDbGH/G9eTwfqwGukLKmaYnrjBoZHcNjX0/7aGWM\nzqy/71aoLgrjAgMBAAGjgb8wgbwwHQYDVR0OBBYEFEZlPe5AwdbrsbjhyH68QL43\n6kY3MB8GA1UdIwQYMBaAFEZlPe5AwdbrsbjhyH68QL436kY3MEoGA1UdEQRDMEGC\nCmdyYWFrLnRlc3SCDCouZ3JhYWsudGVzdIcEfwAAAYcQAAAAAAAAAAAAAAAAAAAA\nAYENcWFAZ3JhYWsudGVzdDAdBgNVHSUEFjAUBggrBgEFBQcDAQYIKwYBBQUHAwIw\nDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOCAQEAj+ojoizcAeBUG1NQ\nh0ARl4TDShVe+s0NKbQr6LBFbhjfi+1qKXcrVxpgObSBPwe2obLdNixBAHilCC/9\nM4bnicqu2YDaQV47lhP/15gG4t/5Yffz1frWPBZ2GNaBIIuSEp+DHSrYVfl6liNx\nNf09JRV8RUclEq9PN5/8HuN79seDOJN4JUsl4wxACBGjkMHwI2/meT/i6PH9YmLE\n/XNkW2BoorJ4t5OyxCtKVUmr1UIZpV6oAkdctz+FVVZi5ascYyu8cp/Hnm4D5Ctj\n1o47DVvLN49XuR9wKdd8H53kSSE8QiHAWHOU5fhVCkYwcMu2i64ybgCA0MfEbkRo\naWEclw==\n-----END CERTIFICATE-----\n";
const EC_CERT = "-----BEGIN CERTIFICATE-----\nMIIBwjCCAWegAwIBAgIUfk44CV50hN6mjlR9J44XK7dqU+wwCgYIKoZIzj0EAwIw\nKDEWMBQGA1UEAwwNZWMuZ3JhYWsudGVzdDEOMAwGA1UECgwFR3JhYWswIBcNMjYw\nOTI0MTkzNzU0WhgPMjEyNjA4MzExOTM3NTRaMCgxFjAUBgNVBAMMDWVjLmdyYWFr\nLnRlc3QxDjAMBgNVBAoMBUdyYWFrMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE\nDuUo0qWaMjmOsTzI2dCvXr4NOQnb2foC4ilhVNLygdU7NK2w8zLHapIyQCbUmWS8\nS8EgJEH+cM2ikeArqnzqq6NtMGswHQYDVR0OBBYEFMamGe91TnC1di3ritwY1ckS\n+WjXMB8GA1UdIwQYMBaAFMamGe91TnC1di3ritwY1ckS+WjXMA8GA1UdEwEB/wQF\nMAMBAf8wGAYDVR0RBBEwD4INZWMuZ3JhYWsudGVzdDAKBggqhkjOPQQDAgNJADBG\nAiEAjFwuNth1XtKvD0g+cAUQJ8tw7vWOUFyYaH8L+nN2ynECIQCJPKtCj4vpchGI\nyh+tG01eHhNnp9Kn9wjwzxhffA6K4A==\n-----END CERTIFICATE-----\n";
const DATA = Buffer.from("graak differential corpus");
const FROM_NODE = {
	pss: "SFsogr27XXgQBoTd25idp05BRX0sy/2AufDCmWGsVWOFfDfw+0pIkZuG3Hze8s64F74oDvzLUqG2Vd6IcnRooY0umbfTM9uNK04NgbpjzAO/lm0o0DP5FIzWACC4LXw0xWDSVGt6jrENksJuHJkCBQHZ3qcrpuIzaBS/81AwGgpWflUAofrc8vmnxcAKLj3VvjEb75fuLg0gamMLDYS7duAg/RNWlsEHnCFqNlj+dRmn1yBZ7U4Jlx56d1xsK612tZygdRTHqwkwHQzXC9kJGURXdVhNrNe8a+0LR/jtE5ziYA9oQoEuOoqTleBBSTIo8ZE50+wELSUyyccaVowF4Q==",
	pssMax: "MopxL1K/vLeBcjBCetJxWaypscIJVcN4M2WHgXE8BD/RDUkHzjSHOUysrYzhPgEQDpnvg4uXqn0m/LSvddQNqa2Kvpa/YiSVh7LqrFDrAs5UWwaUdHW3TNVI8maPiZaKisR4p2RIqnrWsur9YxTJR5gg6zZluNmjUWZohUphqFa/+fCExe8IfSFc5aVtf2oU6HWvtHmDcToJ9ppQ2EIeR5SKEtLmBGfjbwJiIpMF92YLPj8Ivysh+UOejct27JVdTbQLcn9Kev8wOiZf0cMfaHYlCm3AbBsottN1FjDVTqyK5963Ey8iQ2eW92IjHAxDOo9mzxqKLrS4K6QvA14RYg==",
	ecdsa: "MEUCIHd0FLDK14L42qwLfRrlDqnvmdSaLL4IWY6KSGj2j1IMAiEAhGS26zbI9RVv4IktAWdLtP0ZRieAw/jqkVyxyBNRTks=",
	p1363: "SbLlDHPZaH9MYfi6Jx7LXkxQ4njpI9mAAR2UaE9pxpgK8kVn0ms08Rt3hIo11aTEB7oVhwnd10HgOMiGZuT8Tg==",
	oaep: "1ODoT0bz76ueF2NFa80ucJtjs5cY/Nab04G3oF+p+15o6gxSszTf/EvvocI72+egmBugIwkK8kBFMc17rfMw4CmrStPM7AjTF8n+OSJOfGGMAj8WFTioyWfgfEHg4TfZmsEAQAvV0oFiri73CDRmLmoG4CX7MkS+jPl/2wpMhTRhoyILaJEHl4CRHxpZxhkyV9Zxmc+UVGm+2ucRiDjWqBi0v8eUJJeqGYqQ03RfLxrzxXErNcelkXLy2PDWYAWlRZocO32+OV/TJEH3MgZst8sg3OAWJRgR63vtRSomZQklwjHf29OcJcE81KI/bIT6TR45a1zJywZrO8T3s6DLtQ==",
	oaepDefault: "4XRigB6ViONQQiJ1cPP8DEySFqe5i1ZWEl6Z9u9C9ZG9u6sjVvgF8t4Y2gzLfQkSXyL/LiYQV/nrWcLWd/ie6PeAt5a/s3dwUZZ2tEQv4yy+8wvJKUxmksdVzghSe7hDeYlVdRnqPj2aEjt+JyUt8fIQCAG9yeI9/6auAFmq0KDFTR0DBsZS51LSIOGmjF+y3AodsMgzRuLTQTrRPQPFbo1MYqTHbdIMohEhq16idnYVJ3YkENJCIXN0irppRVCEVlPGrD1853svZIPQ0pa3BPPgF/pht40mRuBYET0JPULXxRzslsAUxF19DTltzXpP8RvaBrWJnh42KX8TS9z2Fg==",
	pkcs1: "SRIUH/ys8svwxCFhRnFyXNW0gFEkHuhETu4RjI+ezcV7y23dhOnspAOodQDbeh7vRlvUzbQJBZjZTn5s1/g/DOR3+7GGHQ0bJE76yQnWhC7PJC9A0Etw4O9Cew2kf2ChLK6UyhNLevscP9uCsXeqvyKakv9zPudpTy6n50dmU7LHa8toT8q5OhWeLPTod1ehgKYCwUHFwgGe31euYBfpzEYe3il1uQIT9XuLXtPf0MyjfGWbi8dWo2N6qBBpgfoCHj98aYsIWLHbzhMurwrlDZpOSKq9XGUzfKcuKY/sTNWMA6pBc2GQYtS5eIuUYy7c5wt5GRdFyeSoHGMhT/qeKg==",
	privEnc: "Q0zuSGeVuWWH4BjZP+a/qFQMMy4nggMY06D/scFNoqUaJYAD59jxFgM7OqQt6bDprtQrsUseW9/1vq3YX6d0QvnW7+QPjM4WwsSU3W1PvRqiwn5dfMKt2ta/J4HMUyFlsYObqKuWY7AMiQCLf1BPsFvnFGk+hhC2+Rbpsowo7BMcV7XxdQ/bomRV8ZcGZ7P/QCefdbh/LkWCdUbaAbFq/BCFoJLzUrjdu3SWRqwaLJbvPn8cz7mOAg5GDOwrIWs/JziO+jF1M7W0P9JBhggW+1/FWTfEf6XCxX3hTAt7luW37aWDBnrYz4Ods2hvHsGSzT2KLrwlZN/iOlljLrFo8Q==",
};
const line = (label, value) => console.log(label + ": " + (typeof value === "string" ? value : JSON.stringify(value, (k, v) => (typeof v === "bigint" ? v.toString() + "n" : v))));
const attempt = (label, fn) => {
	try {
		line(label, fn());
	} catch (err) {
		line(label, "throws " + String(err.code).replace(/FAILED/g, "FAIL") + " " + (err instanceof TypeError ? "TypeError" : err instanceof RangeError ? "RangeError" : "Error"));
	}
};
const b64 = (b) => Buffer.from(b).toString("base64");

/* ---- key objects */
const priv = crypto.createPrivateKey(RSA);
const pub = crypto.createPublicKey(RSA);
line("rsa types", [priv.type, pub.type, priv.asymmetricKeyType, pub.asymmetricKeyType]);
line("rsa details", priv.asymmetricKeyDetails);
line("rsa pkcs8 pem roundtrip", priv.export({ type: "pkcs8", format: "pem" }) === RSA);
line("rsa pkcs1 pem", priv.export({ type: "pkcs1", format: "pem" }));
line("rsa spki pem", pub.export({ type: "spki", format: "pem" }));
line("rsa pkcs1 public pem", pub.export({ type: "pkcs1", format: "pem" }));
line("rsa spki der", b64(pub.export({ type: "spki", format: "der" })));
line("rsa pkcs8 der", b64(priv.export({ type: "pkcs8", format: "der" })));
line("rsa jwk public", pub.export({ format: "jwk" }));
line("rsa jwk private", priv.export({ format: "jwk" }));
line("rsa jwk import equals", crypto.createPrivateKey({ key: priv.export({ format: "jwk" }), format: "jwk" }).equals(priv));
line("rsa jwk public import equals", crypto.createPublicKey({ key: pub.export({ format: "jwk" }), format: "jwk" }).equals(pub));
line("rsa public from private equals", crypto.createPublicKey(priv).equals(pub));
line("rsa der import", crypto.createPrivateKey({ key: priv.export({ type: "pkcs1", format: "der" }), format: "der", type: "pkcs1" }).equals(priv));
line("rsa encrypted import", crypto.createPrivateKey({ key: RSA_ENC, passphrase: "hunter2" }).equals(priv));
attempt("rsa encrypted without passphrase", () => crypto.createPrivateKey(RSA_ENC).type);
attempt("rsa bad pem", () => crypto.createPrivateKey("-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n").type);
attempt("private from public fails", () => crypto.createPrivateKey(pub.export({ type: "spki", format: "pem" })).type);
const ec = crypto.createPrivateKey(EC);
const ecPub = crypto.createPublicKey(EC);
line("ec details", [ec.asymmetricKeyType, ec.asymmetricKeyDetails, ecPub.asymmetricKeyDetails]);
line("ec pkcs8 der roundtrip", b64(ec.export({ type: "pkcs8", format: "der" })) === b64(crypto.createPrivateKey(EC).export({ type: "pkcs8", format: "der" })));
line("ec spki pem", ecPub.export({ type: "spki", format: "pem" }));
line("ec jwk public", ecPub.export({ format: "jwk" }));
line("ec jwk private equals", crypto.createPrivateKey({ key: ec.export({ format: "jwk" }), format: "jwk" }).equals(ec));
line("ec384 details", crypto.createPrivateKey(EC384).asymmetricKeyDetails);
line("ec sec1 label", ec.export({ type: "sec1", format: "pem" }).split("\n")[0]);
line("key equals", [priv.equals(pub), pub.equals(crypto.createPublicKey(RSA)), priv.equals(crypto.createPrivateKey(RSA))]);
const secret = crypto.createSecretKey(Buffer.from("0123456789abcdef"));
line("secret", [secret.type, secret.symmetricKeySize, secret.export().toString(), secret.export({ format: "jwk" })]);
attempt("secret asymmetricKeyType", () => String(secret.asymmetricKeyType));

/* ---- sign and verify */
line("pkcs1 sign deterministic", b64(crypto.sign("sha256", DATA, priv)));
line("pkcs1 sign sha512 deterministic", b64(crypto.createSign("sha512").update(DATA).sign(RSA)));
line("pkcs1 verify", [crypto.verify("sha256", DATA, pub, crypto.sign("sha256", DATA, priv)), crypto.verify("sha256", Buffer.from("other"), pub, crypto.sign("sha256", DATA, priv))]);
line("createVerify", crypto.createVerify("RSA-SHA256").update(DATA).verify(RSA, crypto.createSign("RSA-SHA256").update(DATA).sign(RSA)));
line("pss verify node", crypto.verify("sha256", DATA, { key: pub, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }, Buffer.from(FROM_NODE.pss, "base64")));
line("pss max verify node", crypto.verify("sha256", DATA, { key: pub, padding: crypto.constants.RSA_PKCS1_PSS_PADDING }, Buffer.from(FROM_NODE.pssMax, "base64")));
const pssOwn = crypto.sign("sha256", DATA, { key: priv, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 20 });
line("pss own verify", crypto.verify("sha256", DATA, { key: pub, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 20 }, pssOwn));
line("pss wrong salt", crypto.verify("sha256", DATA, { key: pub, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }, pssOwn));
line("ecdsa verify node der", crypto.verify("sha256", DATA, ecPub, Buffer.from(FROM_NODE.ecdsa, "base64")));
line("ecdsa verify node p1363", crypto.verify("sha256", DATA, { key: ecPub, dsaEncoding: "ieee-p1363" }, Buffer.from(FROM_NODE.p1363, "base64")));
const ecSig = crypto.sign("sha256", DATA, { key: ec, dsaEncoding: "ieee-p1363" });
line("ecdsa p1363 own", [ecSig.length, crypto.verify("sha256", DATA, { key: ecPub, dsaEncoding: "ieee-p1363" }, ecSig)]);
line("ecdsa der own", crypto.verify("sha256", DATA, ecPub, crypto.sign("sha256", DATA, ec)));
line("ecdsa 384", crypto.verify("sha384", DATA, crypto.createPublicKey(EC384), crypto.sign("sha384", DATA, crypto.createPrivateKey(EC384))));
attempt("sign with public key", () => crypto.sign("sha256", DATA, pub));
attempt("sign bad digest", () => crypto.sign("nope", DATA, priv));
attempt("sign null algorithm rsa", () => b64(crypto.sign(null, DATA, priv)).length);
const asyncSteps = [];
asyncSteps.push((next) => crypto.sign("sha256", DATA, priv, (err, sig) => (line("sign async", [err === null, sig.length]), next())));
asyncSteps.push((next) => crypto.verify("sha256", DATA, pub, crypto.sign("sha256", DATA, priv), (err, ok) => (line("verify async", [err === null, ok]), next())));

/* ---- RSA encryption */
line("oaep decrypt node", crypto.privateDecrypt({ key: priv, oaepHash: "sha256", oaepLabel: Buffer.from("lbl") }, Buffer.from(FROM_NODE.oaep, "base64")).toString());
line("oaep sha1 default decrypt node", crypto.privateDecrypt(priv, Buffer.from(FROM_NODE.oaepDefault, "base64")).toString());
line("pkcs1 decrypt node", crypto.privateDecrypt({ key: priv, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(FROM_NODE.pkcs1, "base64")).toString());
line("publicDecrypt of privateEncrypt", crypto.publicDecrypt(pub, Buffer.from(FROM_NODE.privEnc, "base64")).toString());
line("privateEncrypt deterministic", b64(crypto.privateEncrypt(priv, DATA)) === FROM_NODE.privEnc);
line("oaep own roundtrip", crypto.privateDecrypt({ key: priv, oaepHash: "sha512" }, crypto.publicEncrypt({ key: pub, oaepHash: "sha512" }, DATA)).toString());
line("oaep sizes", crypto.publicEncrypt(pub, DATA).length);
attempt("oaep wrong hash", () => crypto.privateDecrypt({ key: priv, oaepHash: "sha512" }, Buffer.from(FROM_NODE.oaep, "base64")).toString());
attempt("oaep too long", () => crypto.publicEncrypt(pub, Buffer.alloc(300)).length);

/* ---- ECDH */
const fixedA = Buffer.alloc(32, 0x01);
for (const curve of ["prime256v1", "secp384r1", "secp521r1", "secp256k1"]) {
	const size = { prime256v1: 32, secp384r1: 48, secp521r1: 66, secp256k1: 32 }[curve];
	const a = crypto.createECDH(curve);
	const b = crypto.createECDH(curve);
	a.setPrivateKey(Buffer.concat([Buffer.alloc(1), Buffer.alloc(size - 1, 0x01)]));
	b.setPrivateKey(Buffer.concat([Buffer.alloc(1), Buffer.alloc(size - 1, 0x02)]));
	line("ecdh " + curve + " pub", [a.getPublicKey("hex"), a.getPublicKey("hex", "compressed"), a.getPublicKey("hex", "hybrid")]);
	line("ecdh " + curve + " secret", [a.computeSecret(b.getPublicKey()).toString("hex"), b.computeSecret(a.getPublicKey()).toString("hex")]);
	line("ecdh " + curve + " priv", a.getPrivateKey("hex"));
}
const conv = crypto.createECDH("prime256v1");
conv.setPrivateKey(fixedA);
line("ecdh convertKey compressed", crypto.ECDH.convertKey(conv.getPublicKey(), "prime256v1", undefined, "hex", "compressed"));
line("ecdh convertKey uncompressed", crypto.ECDH.convertKey(conv.getPublicKey(undefined, "compressed"), "prime256v1", undefined, "hex", "uncompressed") === conv.getPublicKey("hex"));
const fresh = crypto.createECDH("prime256v1");
line("ecdh generateKeys", [fresh.generateKeys().length, fresh.getPrivateKey().length]);
attempt("ecdh bad curve", () => crypto.createECDH("nope"));
const badKey = crypto.createECDH("prime256v1");
badKey.setPrivateKey(fixedA);
attempt("ecdh bad public key", () => badKey.computeSecret(Buffer.from("00", "hex")));
attempt("ecdh off-curve public key", () => badKey.computeSecret(Buffer.concat([Buffer.from("04", "hex"), Buffer.alloc(64, 1)])));
attempt("ecdh no key", () => crypto.createECDH("prime256v1").computeSecret(conv.getPublicKey()));
const dhA = crypto.diffieHellman({ privateKey: ec, publicKey: crypto.createPublicKey(EC) });
line("diffieHellman with self", dhA.length);

/* ---- Diffie-Hellman */
const modPow = (base, exp, mod) => {
	let result = 1n;
	base %= mod;
	while (exp > 0n) {
		if (exp & 1n) result = (result * base) % mod;
		base = (base * base) % mod;
		exp >>= 1n;
	}
	return result;
};
for (const name of ["modp1", "modp2", "modp5", "modp14"]) {
	const group = crypto.getDiffieHellman(name);
	const a = crypto.createDiffieHellman(group.getPrime(), 2);
	const b = crypto.createDiffieHellman(group.getPrime(), 2);
	const size = a.getPrime().length;
	a.setPrivateKey(Buffer.alloc(size - 1, 0x21));
	b.setPrivateKey(Buffer.alloc(size - 1, 0x42));
	const prime = BigInt("0x" + a.getPrime("hex"));
	const pubOf = (d) => Buffer.from(modPow(2n, BigInt("0x" + d.getPrivateKey("hex")), prime).toString(16).padStart(size * 2, "0"), "hex");
	const pubA = pubOf(a);
	const pubB = pubOf(b);
	line("dh " + name, [size, a.getGenerator("hex"), a.verifyError, pubA.toString("hex").slice(0, 32), a.computeSecret(pubB).toString("hex") === b.computeSecret(pubA).toString("hex"), b.computeSecret(pubA).toString("hex").slice(0, 32)]);
	attempt("dh " + name + " no public key", () => a.getPublicKey("hex"));
}
const small = crypto.createDiffieHellman(Buffer.from("17", "hex"), Buffer.from("05", "hex"));
line("dh small group", [small.getPrime("hex"), small.getGenerator("hex"), small.verifyError]);
attempt("dh unknown group", () => crypto.getDiffieHellman("modp99"));
attempt("dh too small", () => crypto.createDiffieHellman(256));
const generated = crypto.createDiffieHellman(512);
line("dh generated", [generated.getPrime().length, generated.verifyError, generated.getGenerator("hex")]);
const g1 = crypto.createDiffieHellman(generated.getPrime(), generated.getGenerator());
generated.generateKeys();
g1.generateKeys();
line("dh generated agree", generated.computeSecret(g1.getPublicKey()).equals(g1.computeSecret(generated.getPublicKey())));
const grp = crypto.getDiffieHellman("modp5");
line("dh group members", [typeof grp.setPrivateKey, typeof grp.setPublicKey, typeof grp.generateKeys, grp.verifyError]);
grp.generateKeys();
attempt("dh peer key too small", () => grp.computeSecret(Buffer.from("01", "hex")));
attempt("dh peer key too large", () => grp.computeSecret(grp.getPrime()));
attempt("dh no private key", () => crypto.getDiffieHellman("modp5").computeSecret(Buffer.from("05", "hex")));

/* ---- primes */
line("checkPrime", [crypto.checkPrimeSync(2n), crypto.checkPrimeSync(97n), crypto.checkPrimeSync(100n), crypto.checkPrimeSync(2n ** 127n - 1n), crypto.checkPrimeSync(2n ** 127n + 1n), crypto.checkPrimeSync(Buffer.from("61", "hex"))]);
const p = crypto.generatePrimeSync(64, { bigint: true });
line("generatePrime", [typeof p, p.toString(2).length, crypto.checkPrimeSync(p)]);
const pb = crypto.generatePrimeSync(48);
line("generatePrime buffer", [pb instanceof ArrayBuffer, pb.byteLength, crypto.checkPrimeSync(pb)]);
const safe = crypto.generatePrimeSync(32, { safe: true, bigint: true });
line("generatePrime safe", [safe.toString(2).length, crypto.checkPrimeSync(safe), crypto.checkPrimeSync((safe - 1n) / 2n)]);
asyncSteps.push((next) => crypto.generatePrime(40, { bigint: true }, (err, prime) => (line("generatePrime async", [String(err), crypto.checkPrimeSync(prime)]), next())));
asyncSteps.push((next) => crypto.checkPrime(13n, (err, ok) => (line("checkPrime async", [String(err), ok]), next())));
attempt("generatePrime bad size", () => crypto.generatePrimeSync(0));
const withAdd = crypto.generatePrimeSync(48, { add: 6n, bigint: true });
line("generatePrime add", [withAdd.toString(2).length, crypto.checkPrimeSync(withAdd), withAdd % 6n]);
const withAddRem = crypto.generatePrimeSync(48, { add: 10n, rem: 3n, bigint: true });
line("generatePrime add rem", [withAddRem.toString(2).length, crypto.checkPrimeSync(withAddRem), withAddRem % 10n]);
const safeAdd = crypto.generatePrimeSync(48, { add: 4n, safe: true, bigint: true });
line("generatePrime safe add", [crypto.checkPrimeSync(safeAdd), crypto.checkPrimeSync((safeAdd - 1n) / 2n), safeAdd % 4n]);
const safeAddRem = crypto.generatePrimeSync(48, { add: 24n, rem: 11n, safe: true, bigint: true });
line("generatePrime safe add rem", [crypto.checkPrimeSync(safeAddRem), crypto.checkPrimeSync((safeAddRem - 1n) / 2n), safeAddRem % 24n]);
const remOnly = crypto.generatePrimeSync(48, { rem: 3n, bigint: true });
line("generatePrime rem without add", [typeof remOnly, remOnly.toString(2).length, crypto.checkPrimeSync(remOnly)]);
asyncSteps.push((next) => crypto.generatePrime(40, { add: 6n, bigint: true }, (err, prime) => (line("generatePrime async add", [String(err), crypto.checkPrimeSync(prime), prime % 6n]), next())));
attempt("generatePrime bad add type", () => crypto.generatePrimeSync(48, { add: [1, 2, 3] }));
attempt("generatePrime negative add", () => crypto.generatePrimeSync(48, { add: -1n }));
attempt("generatePrime add too big", () => crypto.generatePrimeSync(16, { add: 2n ** 16n }));
attempt("generatePrime rem not below add", () => crypto.generatePrimeSync(48, { add: 10n, rem: 10n }));

/* ---- key generation */
const gen = crypto.generateKeyPairSync("rsa", { modulusLength: 1024, publicExponent: 3 });
line("gen rsa", [gen.publicKey.type, gen.privateKey.asymmetricKeyDetails]);
const genPem = crypto.generateKeyPairSync("rsa", { modulusLength: 1024, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
line("gen rsa pem", [genPem.publicKey.split("\n")[0], genPem.privateKey.split("\n")[0], crypto.createPublicKey(genPem.privateKey).equals(crypto.createPublicKey(genPem.publicKey))]);
const genDer = crypto.generateKeyPairSync("rsa", { modulusLength: 1024, publicKeyEncoding: { type: "pkcs1", format: "der" }, privateKeyEncoding: { type: "pkcs1", format: "der" } });
line("gen rsa der", [Buffer.isBuffer(genDer.publicKey), Buffer.isBuffer(genDer.privateKey), genDer.privateKey[0]]);
const genEc = crypto.generateKeyPairSync("ec", { namedCurve: "secp384r1" });
line("gen ec", [genEc.privateKey.asymmetricKeyDetails, crypto.verify("sha256", DATA, genEc.publicKey, crypto.sign("sha256", DATA, genEc.privateKey))]);
asyncSteps.push((next) => crypto.generateKeyPair("ec", { namedCurve: "P-256" }, (err, publicKey, privateKey) => (line("gen async ec", [err === null, publicKey.type, privateKey.type]), next())));
attempt("gen bad curve", () => crypto.generateKeyPairSync("ec", { namedCurve: "nope" }));
attempt("gen missing modulus", () => crypto.generateKeyPairSync("rsa", {}));
line("generateKeySync hmac", [crypto.generateKeySync("hmac", { length: 128 }).symmetricKeySize, crypto.generateKeySync("aes", { length: 256 }).symmetricKeySize]);

/* ---- X509 */
for (const [name, pem] of [["rsa", RSA_CERT], ["ec", EC_CERT]]) {
	const cert = new crypto.X509Certificate(pem);
	line(name + " cert subject", cert.subject);
	line(name + " cert issuer", cert.issuer);
	line(name + " cert altnames", String(cert.subjectAltName));
	line(name + " cert dates", [cert.validFrom, cert.validTo, cert.validFromDate.toISOString(), cert.validToDate.toISOString()]);
	line(name + " cert fingerprints", [cert.fingerprint, cert.fingerprint256, cert.fingerprint512]);
	line(name + " cert serial", cert.serialNumber);
	line(name + " cert misc", [cert.ca, String(cert.keyUsage), cert.publicKey.asymmetricKeyType, cert.raw.length]);
	line(name + " cert toString", cert.toString() === pem);
	line(name + " cert legacy", JSON.stringify(cert.toLegacyObject(), (k, v) => (v && v.type === "Buffer" ? "buffer:" + Buffer.from(v.data).toString("hex").slice(0, 16) : v)));
}
const rc = new crypto.X509Certificate(RSA_CERT);
line("cert checkHost", [rc.checkHost("graak.test"), rc.checkHost("a.graak.test"), rc.checkHost("a.b.graak.test"), rc.checkHost("other.test"), rc.checkHost("GRAAK.TEST")]);
line("cert checkIP", [rc.checkIP("127.0.0.1"), rc.checkIP("10.0.0.1"), rc.checkIP("::1")]);
line("cert checkEmail", [rc.checkEmail("qa@graak.test"), rc.checkEmail("x@graak.test")]);
line("cert checkIssued self", rc.checkIssued(rc));
line("cert checkIssued other", rc.checkIssued(new crypto.X509Certificate(EC_CERT)));
line("cert checkPrivateKey", [rc.checkPrivateKey(priv), rc.checkPrivateKey(ec)]);
line("cert from der", new crypto.X509Certificate(rc.raw).fingerprint === rc.fingerprint);
attempt("cert garbage", () => new crypto.X509Certificate("garbage").subject);
line("cert publicKey equals", rc.publicKey.equals(pub));

/* The asynchronous forms run one after another: Node finishes them on a thread pool in no fixed order. */
(function run(i) {
	if (i < asyncSteps.length) asyncSteps[i](() => run(i + 1));
})(0);
