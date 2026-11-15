
    
    select
      count(*) as failures,
      count(*) != 0 as should_warn,
      count(*) != 0 as should_error
    from (
      
    
  
    
    



select score_version
from GREENHOUSE_ANALYTICS.GREENHOUSE_DBT.environmental_score_rules
where score_version is null



  
  
      
    ) dbt_internal_test