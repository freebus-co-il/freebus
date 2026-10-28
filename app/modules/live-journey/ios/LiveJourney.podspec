Pod::Spec.new do |s|
  s.name           = 'LiveJourney'
  s.version        = '1.0.0'
  s.summary        = 'ActivityKit bridge for the active journey'
  s.description    = 'Starts, updates and ends the Live Activity that renders a running journey on the Dynamic Island and the Lock Screen.'
  s.author         = 'FreeBus'
  s.homepage       = 'https://docs.expo.dev/modules/'
  # 16.2 is where `Activity.request(attributes:content:pushType:)` and
  # `update(using:alertConfiguration:)` land; the alert path is the feature.
  s.platforms      = {
    :ios => '16.4'
  }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # Swift/Objective-C compatibility
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
