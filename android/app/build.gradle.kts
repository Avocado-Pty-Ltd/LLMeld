plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("com.facebook.flipper")  // Flipper plugin if needed
}

android {
    namespace = "com.llmeld"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.llmeld"
        minSdk = 24
        targetSdk = 34
        versionCode = 1
        versionName = "1.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }
    
    flavorDimensions += "brand"
    productFlavors {
        create("ezyBiz") {
            dimension = "brand"
            applicationIdSuffix = ".ezybiz"
            versionNameSuffix = "-ezybiz"
        }
        create("callConcierge") {
            dimension = "brand"
            applicationIdSuffix = ".callconcierge"
            versionNameSuffix = "-callconcierge"
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }
    
    compileOptions {
        targetCompatibility = JavaVersion.VERSION_1_8
        sourceCompatibility = JavaVersion.VERSION_1_8
    }
    
    kotlinOptions {
        jvmTarget = "1.8"
    }
    
    packaging {
        jniLibs {
            excludes += listOf("META-INF/**")
        }
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.12.0")
    implementation("androidx.appcompat:appcompat:1.6.1")
    implementation("com.google.android.material:material:1.10.0")
    implementation("androidx.constraintlayout:constraintlayout:2.1.4")
    implementation("androidx.lifecycle:lifecycle-viewmodel-ktx:2.7.0")
    implementation("androidx.lifecycle:lifecycle-livedata-ktx:2.7.0")
    
    // React Native dependencies
    implementation("com.facebook.react:react-android:0.73.6")
    
    // Flipper
    debugImplementation("com.facebook.flipper:flipper:0.185.0")
    debugImplementation("com.facebook.flipper:flipper-network-plugin:0.185.0")
    
    // Test dependencies
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.5")
    androidTestImplementation("androidx.test:runner:1.5.2")
    androidTestImplementation("androidx.test:rules:1.5.0")
}