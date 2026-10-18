// Template: your app's no-AI admin, used by --admin when the AI admin gives no reply. Make the API calls an admin
// would make to create (or approve) the tester's account on your DEV server. devApi keeps cookies between calls and
// can send a double-submit CSRF header (csrfCookie / csrfHeader); every call is logged to scripted.json.
import { devApi, type ScriptedAdmin } from "../../src/scripted-admin";

const example: ScriptedAdmin = async ({ origin, login, who, business, lang2, log }) => {
  const call = devApi({ origin, log }, { prefix: "/api" });
  await call("sign in as the dev admin", "/auth/login", { phone: login.phone, password: login.password });
  await call("create the account", "/admin/users", { phone: who.phone, email: who.email, name: who.first_name, password: who.password, team: business });
  const signIn = `${origin}/login`;
  return {
    message_en: `Hello ${who.first_name}, your account is ready. Sign in at ${signIn} with ${who.phone} and the password ${who.password}.`,
    // message_2 only when the app has a second language (app.yaml second_language); here, Arabic as an example.
    ...(lang2?.code === "ar" ? { message_2: `مرحبا ${who.first_name}، الحساب ديالك واجد. دخل من ${signIn} بـ ${who.phone} والكود ${who.password}.` } : {}),
  };
};
export default example;
