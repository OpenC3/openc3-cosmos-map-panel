# encoding: ascii-8bit

# Create the overall gemspec
Gem::Specification.new do |s|
  s.name = 'openc3-cosmos-map-panel'
  s.summary = '2D Map Panel'
  s.description = <<-EOF
    A 2D map panel for the COSMOS Dashboards tool. Shows positions from
    latitude / longitude or ECEF telemetry with trails. 
  EOF
  s.licenses = 'OpenC3'
  s.authors = ['Clay Ito']
  s.email = ['clay@openc3.com']
  s.homepage = 'https://repo.openc3.com/OpenC3/cosmos'
  s.platform = Gem::Platform::RUBY
  s.required_ruby_version = '>= 3.0'

  if ENV['VERSION']
    s.version = ENV['VERSION'].dup
  else
    time = Time.now.strftime("%Y%m%d%H%M%S")
    s.version = '0.0.0' + ".#{time}"
  end
  s.files = Dir.glob("{tools,public}/**/*") + %w(Rakefile README.md LICENSE.md plugin.txt)

  s.metadata = {
    "source_code_uri" => "https://repo.openc3.com/OpenC3/openc3-cosmos-map-panel",
    "openc3_store_title" => "2D Map Panel",
    "openc3_store_description" => "2D map panel for COSMOS Dashboards: positions and trails from lat/lon or ECEF telemetry.",
    "openc3_store_keywords" => "map, dashboard, panel, position, gps, ecef",
    "openc3_cosmos_minimum_version" => "7.6.0",
    "openc3_store_access_type" => "public"
  }
end
