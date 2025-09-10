
#!/bin/bash

# Auth0 Upgrade Script
# Usage: export AUTH0_TENANT=your-tenant && export AUTH0_TOKEN=your-token && ./upgrade.sh

# Check required environment variables
if [ -z "$AUTH0_TENANT" ]; then
  echo "Error: AUTH0_TENANT environment variable is required"
  echo "Usage: export AUTH0_TENANT=your-tenant && export AUTH0_TOKEN=your-token && ./upgrade.sh"
  exit 1
fi

if [ -z "$AUTH0_TOKEN" ]; then
  echo "Error: AUTH0_TOKEN environment variable is required"
  echo "Usage: export AUTH0_TENANT=your-tenant && export AUTH0_TOKEN=your-token && ./upgrade.sh"
  exit 1
fi

# Construct Auth0 API base URL
AUTH0_API_URL="https://${AUTH0_TENANT}.auth0.com/api/v2"

echo "Fetching connections from ${AUTH0_API_URL}/connections..."

# Fetch connections and iterate through them using jq
curl -s \
  --url "${AUTH0_API_URL}/connections" \
  --header "authorization: Bearer ${AUTH0_TOKEN}" | \
jq -r '.[] | .id' | \
while read -r connection_id; do
  echo "Updating connection: ${connection_id}"
  
  curl --request PATCH \
    --url "${AUTH0_API_URL}/connections/${connection_id}" \
    --header "authorization: Bearer ${AUTH0_TOKEN}" \
    --header 'cache-control: no-cache' \
    --header 'content-type: application/json' \
    --data '{ "is_domain_connection": true }' \
    --silent --show-error
    
  if [ $? -eq 0 ]; then
    echo "✓ Successfully updated connection: ${connection_id}"
  else
    echo "✗ Failed to update connection: ${connection_id}"
  fi
done

echo "Upgrade process completed."
