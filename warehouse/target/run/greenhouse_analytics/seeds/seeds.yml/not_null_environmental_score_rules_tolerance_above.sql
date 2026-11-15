
    
    select
      count(*) as failures,
      count(*) != 0 as should_warn,
      count(*) != 0 as should_error
    from (
      
    
  
    
    



select tolerance_above
from GREENHOUSE_ANALYTICS.GREENHOUSE_DBT.environmental_score_rules
where tolerance_above is null



  
  
      
    ) dbt_internal_test