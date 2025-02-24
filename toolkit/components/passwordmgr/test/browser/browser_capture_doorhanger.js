/*
 * Test capture popup notifications
 */

const BRAND_BUNDLE = Services.strings.createBundle("chrome://branding/locale/brand.properties");
const BRAND_SHORT_NAME = BRAND_BUNDLE.GetStringFromName("brandShortName");

let nsLoginInfo = new Components.Constructor("@mozilla.org/login-manager/loginInfo;1",
                                             Ci.nsILoginInfo, "init");
let login1 = new nsLoginInfo("http://example.com", "http://example.com", null,
                             "notifyu1", "notifyp1", "user", "pass");
let login2 = new nsLoginInfo("http://example.com", "http://example.com", null,
                             "", "notifyp1", "", "pass");
let login1B = new nsLoginInfo("http://example.com", "http://example.com", null,
                              "notifyu1B", "notifyp1B", "user", "pass");
let login2B = new nsLoginInfo("http://example.com", "http://example.com", null,
                              "", "notifyp1B", "", "pass");

requestLongerTimeout(2);

add_task(async function setup() {
  // Load recipes for this test.
  let recipeParent = await LoginManagerParent.recipeParentPromise;
  await recipeParent.load({
    siteRecipes: [{
      hosts: ["example.org"],
      usernameSelector: "#user",
      passwordSelector: "#pass",
    }],
  });
});

add_task(async function test_remember_opens() {
  await testSubmittingLoginForm("subtst_notifications_1.html", function(fieldValues) {
    is(fieldValues.username, "notifyu1", "Checking submitted username");
    is(fieldValues.password, "notifyp1", "Checking submitted password");
    let notif = getCaptureDoorhanger("password-save");
    ok(notif, "got notification popup");
    notif.remove();
  });
});

add_task(async function test_clickNever() {
  await testSubmittingLoginForm("subtst_notifications_1.html", async function(fieldValues) {
    is(fieldValues.username, "notifyu1", "Checking submitted username");
    is(fieldValues.password, "notifyp1", "Checking submitted password");
    let notif = getCaptureDoorhanger("password-save");
    ok(notif, "got notification popup");
    is(true, Services.logins.getLoginSavingEnabled("http://example.com"),
       "Checking for login saving enabled");

    await checkDoorhangerUsernamePassword("notifyu1", "notifyp1");
    clickDoorhangerButton(notif, NEVER_MENUITEM);
  });

  is(Services.logins.getAllLogins().length, 0, "Should not have any logins yet");

  info("Make sure Never took effect");
  await testSubmittingLoginForm("subtst_notifications_1.html", function(fieldValues) {
    is(fieldValues.username, "notifyu1", "Checking submitted username");
    is(fieldValues.password, "notifyp1", "Checking submitted password");
    let notif = getCaptureDoorhanger("password-save");
    ok(!notif, "checking for no notification popup");
    is(false, Services.logins.getLoginSavingEnabled("http://example.com"),
       "Checking for login saving disabled");
    Services.logins.setLoginSavingEnabled("http://example.com", true);
  });

  is(Services.logins.getAllLogins().length, 0, "Should not have any logins yet");
});

add_task(async function test_clickRemember() {
  await testSubmittingLoginForm("subtst_notifications_1.html", async function(fieldValues) {
    is(fieldValues.username, "notifyu1", "Checking submitted username");
    is(fieldValues.password, "notifyp1", "Checking submitted password");
    let notif = getCaptureDoorhanger("password-save");
    ok(notif, "got notification popup");

    is(Services.logins.getAllLogins().length, 0, "Should not have any logins yet");

    await checkDoorhangerUsernamePassword("notifyu1", "notifyp1");
    clickDoorhangerButton(notif, REMEMBER_BUTTON);
  });

  let logins = Services.logins.getAllLogins();
  is(logins.length, 1, "Should only have 1 login");
  let login = logins[0].QueryInterface(Ci.nsILoginMetaInfo);
  is(login.username, "notifyu1", "Check the username used on the new entry");
  is(login.password, "notifyp1", "Check the password used on the new entry");
  is(login.timesUsed, 1, "Check times used on new entry");

  info("Make sure Remember took effect and we don't prompt for an existing login");
  await testSubmittingLoginForm("subtst_notifications_1.html", function(fieldValues) {
    is(fieldValues.username, "notifyu1", "Checking submitted username");
    is(fieldValues.password, "notifyp1", "Checking submitted password");
    let notif = getCaptureDoorhanger("password-save");
    ok(!notif, "checking for no notification popup");
  });

  logins = Services.logins.getAllLogins();
  is(logins.length, 1, "Should only have 1 login");
  login = logins[0].QueryInterface(Ci.nsILoginMetaInfo);
  is(login.username, "notifyu1", "Check the username used");
  is(login.password, "notifyp1", "Check the password used");
  is(login.timesUsed, 2, "Check times used incremented");

  checkOnlyLoginWasUsedTwice({ justChanged: false });

  // remove that login
  Services.logins.removeLogin(login1);
});

/* signons.rememberSignons pref tests... */

add_task(async function test_rememberSignonsFalse() {
  info("Make sure we don't prompt with rememberSignons=false");
  Services.prefs.setBoolPref("signon.rememberSignons", false);

  await testSubmittingLoginForm("subtst_notifications_1.html", function(fieldValues) {
    is(fieldValues.username, "notifyu1", "Checking submitted username");
    is(fieldValues.password, "notifyp1", "Checking submitted password");
    let notif = getCaptureDoorhanger("password-save");
    ok(!notif, "checking for no notification popup");
  });

  is(Services.logins.getAllLogins().length, 0, "Should not have any logins yet");
});

add_task(async function test_rememberSignonsTrue() {
  info("Make sure we prompt with rememberSignons=true");
  Services.prefs.setBoolPref("signon.rememberSignons", true);

  await testSubmittingLoginForm("subtst_notifications_1.html", function(fieldValues) {
    is(fieldValues.username, "notifyu1", "Checking submitted username");
    is(fieldValues.password, "notifyp1", "Checking submitted password");
    let notif = getCaptureDoorhanger("password-save");
    ok(notif, "got notification popup");
    notif.remove();
  });

  is(Services.logins.getAllLogins().length, 0, "Should not have any logins yet");
});

/* autocomplete=off tests... */

add_task(async function test_autocompleteOffUsername() {
  info("Check for notification popup when autocomplete=off present on username");

  await testSubmittingLoginForm("subtst_notifications_2.html", function(fieldValues) {
    is(fieldValues.username, "notifyu1", "Checking submitted username");
    is(fieldValues.password, "notifyp1", "Checking submitted password");
    let notif = getCaptureDoorhanger("password-save");
    ok(notif, "checking for notification popup");
    notif.remove();
  });

  is(Services.logins.getAllLogins().length, 0, "Should not have any logins yet");
});

add_task(async function test_autocompleteOffPassword() {
  info("Check for notification popup when autocomplete=off present on password");

  await testSubmittingLoginForm("subtst_notifications_3.html", function(fieldValues) {
    is(fieldValues.username, "notifyu1", "Checking submitted username");
    is(fieldValues.password, "notifyp1", "Checking submitted password");
    let notif = getCaptureDoorhanger("password-save");
    ok(notif, "checking for notification popup");
    notif.remove();
  });

  is(Services.logins.getAllLogins().length, 0, "Should not have any logins yet");
});

add_task(async function test_autocompleteOffForm() {
  info("Check for notification popup when autocomplete=off present on form");

  await testSubmittingLoginForm("subtst_notifications_4.html", function(fieldValues) {
    is(fieldValues.username, "notifyu1", "Checking submitted username");
    is(fieldValues.password, "notifyp1", "Checking submitted password");
    let notif = getCaptureDoorhanger("password-save");
    ok(notif, "checking for notification popup");
    notif.remove();
  });

  is(Services.logins.getAllLogins().length, 0, "Should not have any logins yet");
});


add_task(async function test_noPasswordField() {
  info("Check for no notification popup when no password field present");

  await testSubmittingLoginForm("subtst_notifications_5.html", function(fieldValues) {
    is(fieldValues.username, "notifyu1", "Checking submitted username");
    is(fieldValues.password, "null", "Checking submitted password");
    let notif = getCaptureDoorhanger("password-save");
    ok(!notif, "checking for no notification popup");
  });

  is(Services.logins.getAllLogins().length, 0, "Should not have any logins yet");
});

add_task(async function test_pwOnlyLoginMatchesForm() {
  info("Check for update popup when existing pw-only login matches form.");
  Services.logins.addLogin(login2);

  await testSubmittingLoginForm("subtst_notifications_1.html", function(fieldValues) {
    is(fieldValues.username, "notifyu1", "Checking submitted username");
    is(fieldValues.password, "notifyp1", "Checking submitted password");
    let notif = getCaptureDoorhanger("password-change");
    ok(notif, "checking for notification popup");
    notif.remove();
  });

  let logins = Services.logins.getAllLogins();
  is(logins.length, 1, "Should only have 1 login");
  let login = logins[0].QueryInterface(Ci.nsILoginMetaInfo);
  is(login.username, "", "Check the username");
  is(login.password, "notifyp1", "Check the password");
  is(login.timesUsed, 1, "Check times used");

  Services.logins.removeLogin(login2);
});

add_task(async function test_pwOnlyFormMatchesLogin() {
  info("Check for no notification popup when pw-only form matches existing login.");
  Services.logins.addLogin(login1);

  await testSubmittingLoginForm("subtst_notifications_6.html", function(fieldValues) {
    is(fieldValues.username, "null", "Checking submitted username");
    is(fieldValues.password, "notifyp1", "Checking submitted password");
    let notif = getCaptureDoorhanger("password-save");
    ok(!notif, "checking for no notification popup");
  });

  let logins = Services.logins.getAllLogins();
  is(logins.length, 1, "Should only have 1 login");
  let login = logins[0].QueryInterface(Ci.nsILoginMetaInfo);
  is(login.username, "notifyu1", "Check the username");
  is(login.password, "notifyp1", "Check the password");
  is(login.timesUsed, 2, "Check times used");

  Services.logins.removeLogin(login1);
});

add_task(async function test_pwOnlyFormDoesntMatchExisting() {
  info("Check for notification popup when pw-only form doesn't match existing login.");
  Services.logins.addLogin(login1B);

  await testSubmittingLoginForm("subtst_notifications_6.html", function(fieldValues) {
    is(fieldValues.username, "null", "Checking submitted username");
    is(fieldValues.password, "notifyp1", "Checking submitted password");
    let notif = getCaptureDoorhanger("password-save");
    ok(notif, "got notification popup");
    notif.remove();
  });

  let logins = Services.logins.getAllLogins();
  is(logins.length, 1, "Should only have 1 login");
  let login = logins[0].QueryInterface(Ci.nsILoginMetaInfo);
  is(login.username, "notifyu1B", "Check the username unchanged");
  is(login.password, "notifyp1B", "Check the password unchanged");
  is(login.timesUsed, 1, "Check times used");

  Services.logins.removeLogin(login1B);
});

add_task(async function test_changeUPLoginOnUPForm_dont() {
  info("Check for change-password popup, u+p login on u+p form. (not changed)");
  Services.logins.addLogin(login1);

  await testSubmittingLoginForm("subtst_notifications_8.html", async function(fieldValues) {
    is(fieldValues.username, "notifyu1", "Checking submitted username");
    is(fieldValues.password, "pass2", "Checking submitted password");
    let notif = getCaptureDoorhanger("password-change");
    ok(notif, "got notification popup");

    await checkDoorhangerUsernamePassword("notifyu1", "pass2");
    clickDoorhangerButton(notif, DONT_CHANGE_BUTTON);
  });

  let logins = Services.logins.getAllLogins();
  is(logins.length, 1, "Should only have 1 login");
  let login = logins[0].QueryInterface(Ci.nsILoginMetaInfo);
  is(login.username, "notifyu1", "Check the username unchanged");
  is(login.password, "notifyp1", "Check the password unchanged");
  is(login.timesUsed, 1, "Check times used");

  Services.logins.removeLogin(login1);
});

add_task(async function test_changeUPLoginOnUPForm_change() {
  info("Check for change-password popup, u+p login on u+p form.");
  Services.logins.addLogin(login1);

  await testSubmittingLoginForm("subtst_notifications_8.html", async function(fieldValues) {
    is(fieldValues.username, "notifyu1", "Checking submitted username");
    is(fieldValues.password, "pass2", "Checking submitted password");
    let notif = getCaptureDoorhanger("password-change");
    ok(notif, "got notification popup");

    await checkDoorhangerUsernamePassword("notifyu1", "pass2");
    clickDoorhangerButton(notif, CHANGE_BUTTON);

    ok(!getCaptureDoorhanger("password-change"), "popup should be gone");
  });

  let logins = Services.logins.getAllLogins();
  is(logins.length, 1, "Should only have 1 login");
  let login = logins[0].QueryInterface(Ci.nsILoginMetaInfo);
  is(login.username, "notifyu1", "Check the username unchanged");
  is(login.password, "pass2", "Check the password changed");
  is(login.timesUsed, 2, "Check times used");

  checkOnlyLoginWasUsedTwice({ justChanged: true });

  // cleanup
  login1.password = "pass2";
  Services.logins.removeLogin(login1);
  login1.password = "notifyp1";
});

add_task(async function test_changePLoginOnUPForm() {
  info("Check for change-password popup, p-only login on u+p form.");
  Services.logins.addLogin(login2);

  await testSubmittingLoginForm("subtst_notifications_9.html", async function(fieldValues) {
    is(fieldValues.username, "", "Checking submitted username");
    is(fieldValues.password, "pass2", "Checking submitted password");
    let notif = getCaptureDoorhanger("password-change");
    ok(notif, "got notification popup");

    await checkDoorhangerUsernamePassword("", "pass2");
    clickDoorhangerButton(notif, CHANGE_BUTTON);

    ok(!getCaptureDoorhanger("password-change"), "popup should be gone");
  });

  let logins = Services.logins.getAllLogins();
  is(logins.length, 1, "Should only have 1 login");
  let login = logins[0].QueryInterface(Ci.nsILoginMetaInfo);
  is(login.username, "", "Check the username unchanged");
  is(login.password, "pass2", "Check the password changed");
  is(login.timesUsed, 2, "Check times used");

  // no cleanup -- saved password to be used in the next test.
});

add_task(async function test_changePLoginOnPForm() {
  info("Check for change-password popup, p-only login on p-only form.");

  await testSubmittingLoginForm("subtst_notifications_10.html", async function(fieldValues) {
    is(fieldValues.username, "null", "Checking submitted username");
    is(fieldValues.password, "notifyp1", "Checking submitted password");
    let notif = getCaptureDoorhanger("password-change");
    ok(notif, "got notification popup");

    await checkDoorhangerUsernamePassword("", "notifyp1");
    clickDoorhangerButton(notif, CHANGE_BUTTON);

    ok(!getCaptureDoorhanger("password-change"), "popup should be gone");
  });

  let logins = Services.logins.getAllLogins();
  is(logins.length, 1, "Should only have 1 login");
  let login = logins[0].QueryInterface(Ci.nsILoginMetaInfo);
  is(login.username, "", "Check the username unchanged");
  is(login.password, "notifyp1", "Check the password changed");
  is(login.timesUsed, 3, "Check times used");

  Services.logins.removeLogin(login2);
});

add_task(async function test_checkUPSaveText() {
  info("Check text on a user+pass notification popup");

  await testSubmittingLoginForm("subtst_notifications_1.html", function(fieldValues) {
    is(fieldValues.username, "notifyu1", "Checking submitted username");
    is(fieldValues.password, "notifyp1", "Checking submitted password");
    let notif = getCaptureDoorhanger("password-save");
    ok(notif, "got notification popup");
    // Check the text, which comes from the localized saveLoginMsg string.
    let notificationText = notif.message;
    let expectedText = "Would you like " + BRAND_SHORT_NAME + " to save this login for example.com?";
    is(expectedText, notificationText, "Checking text: " + notificationText);
    notif.remove();
  });

  is(Services.logins.getAllLogins().length, 0, "Should not have any logins yet");
});

add_task(async function test_checkPSaveText() {
  info("Check text on a pass-only notification popup");

  await testSubmittingLoginForm("subtst_notifications_6.html", function(fieldValues) {
    is(fieldValues.username, "null", "Checking submitted username");
    is(fieldValues.password, "notifyp1", "Checking submitted password");
    let notif = getCaptureDoorhanger("password-save");
    ok(notif, "got notification popup");
    // Check the text, which comes from the localized saveLoginMsgNoUser string.
    let notificationText = notif.message;
    let expectedText = "Would you like " + BRAND_SHORT_NAME + " to save this password for example.com?";
    is(expectedText, notificationText, "Checking text: " + notificationText);
    notif.remove();
  });

  is(Services.logins.getAllLogins().length, 0, "Should not have any logins yet");
});

add_task(async function test_capture2pw0un() {
  info("Check for notification popup when a form with 2 password fields (no username) " +
       "is submitted and there are no saved logins.");

  await testSubmittingLoginForm("subtst_notifications_2pw_0un.html", function(fieldValues) {
    is(fieldValues.username, "null", "Checking submitted username");
    is(fieldValues.password, "notifyp1", "Checking submitted password");
    let notif = getCaptureDoorhanger("password-save");
    ok(notif, "got notification popup");
    notif.remove();
  });

  is(Services.logins.getAllLogins().length, 0, "Should not have any logins yet");
});

add_task(async function test_change2pw0unExistingDifferentUP() {
  info("Check for notification popup when a form with 2 password fields (no username) " +
       "is submitted and there is a saved login with a username and different password.");

  Services.logins.addLogin(login1B);

  await testSubmittingLoginForm("subtst_notifications_2pw_0un.html", function(fieldValues) {
    is(fieldValues.username, "null", "Checking submitted username");
    is(fieldValues.password, "notifyp1", "Checking submitted password");
    let notif = getCaptureDoorhanger("password-change");
    ok(notif, "got notification popup");
    notif.remove();
  });

  let logins = Services.logins.getAllLogins();
  is(logins.length, 1, "Should only have 1 login");
  let login = logins[0].QueryInterface(Ci.nsILoginMetaInfo);
  is(login.username, "notifyu1B", "Check the username unchanged");
  is(login.password, "notifyp1B", "Check the password unchanged");
  is(login.timesUsed, 1, "Check times used");

  Services.logins.removeLogin(login1B);
});

add_task(async function test_change2pw0unExistingDifferentP() {
  info("Check for notification popup when a form with 2 password fields (no username) " +
       "is submitted and there is a saved login with no username and different password.");

  Services.logins.addLogin(login2B);

  await testSubmittingLoginForm("subtst_notifications_2pw_0un.html", function(fieldValues) {
    is(fieldValues.username, "null", "Checking submitted username");
    is(fieldValues.password, "notifyp1", "Checking submitted password");
    let notif = getCaptureDoorhanger("password-change");
    ok(notif, "got notification popup");
    notif.remove();
  });

  let logins = Services.logins.getAllLogins();
  is(logins.length, 1, "Should only have 1 login");
  let login = logins[0].QueryInterface(Ci.nsILoginMetaInfo);
  is(login.username, "", "Check the username unchanged");
  is(login.password, "notifyp1B", "Check the password unchanged");
  is(login.timesUsed, 1, "Check times used");

  Services.logins.removeLogin(login2B);
});

add_task(async function test_change2pw0unExistingWithSameP() {
  info("Check for no notification popup when a form with 2 password fields (no username) " +
       "is submitted and there is a saved login with a username and the same password.");

  Services.logins.addLogin(login2);

  await testSubmittingLoginForm("subtst_notifications_2pw_0un.html", function(fieldValues) {
    is(fieldValues.username, "null", "Checking submitted username");
    is(fieldValues.password, "notifyp1", "Checking submitted password");
    let notif = getCaptureDoorhanger("password-change");
    ok(!notif, "checking for no notification popup");
  });

  let logins = Services.logins.getAllLogins();
  is(logins.length, 1, "Should only have 1 login");
  let login = logins[0].QueryInterface(Ci.nsILoginMetaInfo);
  is(login.username, "", "Check the username unchanged");
  is(login.password, "notifyp1", "Check the password unchanged");
  is(login.timesUsed, 2, "Check times used incremented");

  checkOnlyLoginWasUsedTwice({ justChanged: false });

  Services.logins.removeLogin(login2);
});

add_task(async function test_changeUPLoginOnPUpdateForm() {
  info("Check for change-password popup, u+p login on password update form.");
  Services.logins.addLogin(login1);

  await testSubmittingLoginForm("subtst_notifications_change_p.html", async function(fieldValues) {
    is(fieldValues.username, "null", "Checking submitted username");
    is(fieldValues.password, "pass2", "Checking submitted password");
    let notif = getCaptureDoorhanger("password-change");
    ok(notif, "got notification popup");

    await checkDoorhangerUsernamePassword("notifyu1", "pass2");
    clickDoorhangerButton(notif, CHANGE_BUTTON);

    ok(!getCaptureDoorhanger("password-change"), "popup should be gone");
  });

  let logins = Services.logins.getAllLogins();
  is(logins.length, 1, "Should only have 1 login");
  let login = logins[0].QueryInterface(Ci.nsILoginMetaInfo);
  is(login.username, "notifyu1", "Check the username unchanged");
  is(login.password, "pass2", "Check the password changed");
  is(login.timesUsed, 2, "Check times used");

  checkOnlyLoginWasUsedTwice({ justChanged: true });

  // cleanup
  login1.password = "pass2";
  Services.logins.removeLogin(login1);
  login1.password = "notifyp1";
});

add_task(async function test_recipeCaptureFields_NewLogin() {
  info("Check that we capture the proper fields when a field recipe is in use.");

  await testSubmittingLoginForm("subtst_notifications_2pw_1un_1text.html", async function(fieldValues) {
    is(fieldValues.username, "notifyu1", "Checking submitted username");
    is(fieldValues.password, "notifyp1", "Checking submitted password");
    let notif = getCaptureDoorhanger("password-save");
    ok(notif, "got notification popup");

    // Sanity check, no logins should exist yet.
    let logins = Services.logins.getAllLogins();
    is(logins.length, 0, "Should not have any logins yet");

    await checkDoorhangerUsernamePassword("notifyu1", "notifyp1");
    clickDoorhangerButton(notif, REMEMBER_BUTTON);
  }, "http://example.org"); // The recipe is for example.org

  let logins = Services.logins.getAllLogins();
  is(logins.length, 1, "Should only have 1 login");
  let login = logins[0].QueryInterface(Ci.nsILoginMetaInfo);
  is(login.username, "notifyu1", "Check the username unchanged");
  is(login.password, "notifyp1", "Check the password unchanged");
  is(login.timesUsed, 1, "Check times used");
});

add_task(async function test_recipeCaptureFields_ExistingLogin() {
  info("Check that we capture the proper fields when a field recipe is in use " +
       "and there is a matching login");

  await testSubmittingLoginForm("subtst_notifications_2pw_1un_1text.html", function(fieldValues) {
    is(fieldValues.username, "notifyu1", "Checking submitted username");
    is(fieldValues.password, "notifyp1", "Checking submitted password");
    let notif = getCaptureDoorhanger("password-save");
    ok(!notif, "checking for no notification popup");
  }, "http://example.org");

  checkOnlyLoginWasUsedTwice({ justChanged: false });
  let logins = Services.logins.getAllLogins();
  is(logins.length, 1, "Should only have 1 login");
  let login = logins[0].QueryInterface(Ci.nsILoginMetaInfo);
  is(login.username, "notifyu1", "Check the username unchanged");
  is(login.password, "notifyp1", "Check the password unchanged");
  is(login.timesUsed, 2, "Check times used incremented");

  Services.logins.removeAllLogins();
});

add_task(async function test_noShowPasswordOnDismissal() {
  info("Check for no Show Password field when the doorhanger is dismissed");

  await testSubmittingLoginForm("subtst_notifications_1.html", async function(fieldValues) {
    info("Opening popup");
    let notif = getCaptureDoorhanger("password-save");
    let { panel } = PopupNotifications;

    info("Hiding popup.");
    let promiseHidden = BrowserTestUtils.waitForEvent(panel, "popuphidden");
    panel.hidePopup();
    await promiseHidden;

    info("Clicking on anchor to reshow popup.");
    let promiseShown = BrowserTestUtils.waitForEvent(panel, "popupshown");
    notif.anchorElement.click();
    await promiseShown;

    let passwordVisiblityToggle = panel.querySelector("#password-notification-visibilityToggle");
    is(passwordVisiblityToggle.hidden, true, "Check that the Show Password field is Hidden");
  });
});

// TODO:
// * existing login test, form has different password --> change password, no save prompt
