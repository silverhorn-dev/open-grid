plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Eigene Builds: Router-Domain fuer verifizierte App-Links (https://<host>/invite, /age-callback).
// Ohne Angabe gibt es nur den Einstieg per opengrid://-Link.
val appLinkHost = (findProperty("opengrid.appLinkHost") as String?)?.takeIf { it.isNotBlank() } ?: "opengrid.invalid"

android {
    namespace = "org.opengrid.app"
    compileSdk = 34

    defaultConfig {
        applicationId = "org.opengrid.app"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0"
        manifestPlaceholders["appLinkHost"] = appLinkHost
    }

    // Release-Signatur nur ueber Umgebungsvariablen (android/build.sh), nie im Repository.
    val keystore = System.getenv("OPENGRID_KEYSTORE")
    signingConfigs {
        if (keystore != null) {
            create("release") {
                storeFile = file(keystore)
                storePassword = System.getenv("OPENGRID_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("OPENGRID_KEY_ALIAS")
                keyPassword = System.getenv("OPENGRID_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            if (keystore != null) signingConfig = signingConfigs.getByName("release")
        }
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.activity:activity-ktx:1.9.2")
    implementation("androidx.webkit:webkit:1.11.0")
}
