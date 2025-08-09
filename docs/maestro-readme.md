---
description: Maestro is the simplest and most effective UI testing framework.
---

# What is Maestro?

{% hint style="success" %}
🚀  **Running in the Cloud**

Ready to wire into CI or scale up your testing? Start running your flows on Maestro's enterprise-grade cloud infrastructure: [**Run Maestro tests in the cloud**](https://signin.maestro.dev/sign-up)
{% endhint %}

{% embed url="https://vimeo.com/767721667/d972c5f08e" %}

## Why Maestro?

Maestro is built on learnings from its predecessors (Appium, Espresso, UIAutomator, XCTest, Selenium, Playwright) and allows you to easily define and test your Flows.

{% hint style="info" %}
**What are Flows?** Think of Flows as parts of the user journey in your app. Login, Checkout and Add to Cart are three examples of possible Flows that can be defined and tested using Maestro.
{% endhint %}

* Built-in tolerance to flakiness. UI elements will not always be where you expect them, screen tap will not always go through, etc. Maestro embraces the instability of mobile applications and devices and tries to counter it.
* Built-in tolerance to delays. No need to pepper your tests with `sleep()` calls. Maestro knows that it might take time to load the content (i.e. over the network) and automatically waits for it (but no longer than required).
* Blazingly fast iteration. Tests are interpreted, no need to compile anything. Maestro is able to continuously monitor your test files and rerun them as they change.
* Declarative yet powerful syntax. Define your tests in a `yaml` file.
* Simple setup. Maestro is a single binary that works anywhere.

## Examples

#### Twitter (Mobile)

<figure><img src="https://2384395183-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2Fn5KVIOjVkVjYRyVWZ0yT%2Fuploads%2FBdkVbb4VQTkL4zLm6nvm%2Ftwitter_continuous_v3_fast.gif?alt=media&#x26;token=8a812b85-3b44-44f0-9137-3e74293b1acc" alt=""><figcaption></figcaption></figure>

#### Simple Examples

{% tabs %}
{% tab title="Android" %}
```yaml
# flow_contacts_android.yaml

appId: com.android.contacts
---
- launchApp
- tapOn: "Create new contact"
- tapOn: "First Name"
- inputText: "John"
- tapOn: "Last Name"
- inputText: "Snow"
- tapOn: "Save"
```
{% endtab %}

{% tab title="iOS" %}
```yaml
# flow_contacts_ios.yaml

appId: com.apple.MobileAddressBook
---
- launchApp
- tapOn: "John Appleseed"
- tapOn: "Edit"
- tapOn: "Add phone"
- inputText: "123123"
- tapOn: "Done"
```
{% endtab %}

{% tab title="Web" %}
```yaml
url: https://example.com
---
- launchApp
- tapOn: More information...
- assertVisible: Further Reading
```
{% endtab %}
{% endtabs %}

## Platform Support

<table><thead><tr><th width="572">Platform</th><th align="center">Supported</th></tr></thead><tbody><tr><td><a href="../platform-support/android-views">Android - Views</a></td><td align="center">✅</td></tr><tr><td><a href="../platform-support/android-jetpack-compose">Android - Jetpack Compose</a></td><td align="center">✅</td></tr><tr><td><a href="../platform-support/ios-uikit">iOS - UIKit</a></td><td align="center">✅</td></tr><tr><td><a href="../platform-support/ios-swiftui">iOS - SwiftUI</a></td><td align="center">✅</td></tr><tr><td><a href="../platform-support/react-native">React Native</a></td><td align="center">✅</td></tr><tr><td><a href="../platform-support/flutter">Flutter</a></td><td align="center">✅</td></tr><tr><td><a href="../platform-support/web-views">Web Views</a></td><td align="center">✅</td></tr><tr><td><a href="../platform-support/web-desktop-browser">Web (Desktop Browser)</a></td><td align="center">✅</td></tr><tr><td>.NET MAUI iOS</td><td align="center">✅</td></tr><tr><td>.NET MAUI Android</td><td align="center">✅</td></tr></tbody></table>

## Resources

* Blog Post: [**Introducing: Maestro — Painless Mobile UI Automation**](https://maestro.dev/blog/introducing-maestro-painless-mobile-ui-automation)
* GitHub Repository: [**https://github.com/mobile-dev-inc/maestro**](https://github.com/mobile-dev-inc/maestro)
* Public Slack Channel: [**Join the workspace**](https://docsend.com/view/3r2sf8fvvcjxvbtk), then head to the `#maestro` channel



## Get Started

Get started by installing the Maestro CLI:
